import express, { Request, Response } from "express";
import {
    Fleet,
    FleetComposition,
    Inventory,
    InventoryItem,
    ShipType,
    System,
    User,
    sequelize,
} from "./database";
import { v4 } from "uuid";
import { serializeUser, serializeUserForWebsite } from "./serializers";
import { Transaction } from "sequelize";
import asyncSequentialMap from "./utils/asyncSequentialMap";
import admin from "firebase-admin";
import { getAuth } from "firebase-admin/auth";
import generateApiKey from "generate-api-key";
import * as OpenApiValidator from "express-openapi-validator";
import swaggerUI from "swagger-ui-express";
import { paths } from "./schema";
import fs from "fs";
import YAML from "yaml";
import addFleetsRoutes from "./app/fleets";
import addShipTypesRoutes from "./app/shipTypes";
import addResourcesRoutes from "./app/resources";
import logger, { loggerMiddleware, traceIdStore } from "./utils/logger";
import moduleName from "./utils/moduleName";
import HttpError from "./utils/HttpError";
import { rateLimit } from "express-rate-limit";
import { NODE_ENV } from "./config";
import authMiddleware from "./utils/authMiddleware";
import _ from "lodash";
import setupTransaction from "./utils/setupTransaction";
import addSystemsRoutes from "./app/systems";
import addUsersRoutes from "./app/users";

const LOGGER = logger(moduleName(__filename));

if (process.env.FIREBASE_API_TOKEN) {
    admin.initializeApp({
        credential: admin.credential.cert(
            JSON.parse(process.env.FIREBASE_API_TOKEN),
        ),
    });
}

const app = express();

export const SPEED = 1; // In units/seconds

const nonGameRouter = express.Router();

nonGameRouter.post("/users/login", async (req, res) => {
    const idToken = req.body["idToken"] as string;

    const response = await getAuth().verifyIdToken(idToken);

    const firebaseUid = response.uid;

    let user = await User.findOne({ where: { firebaseUid } });

    if (user == null) {
        // Generate a user and its starting spot
        await setupTransaction(sequelize, async (transaction) => {
            const pool =
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            const token = "spbo_" + generateApiKey({ length: 32, pool });
            const generatedUsername = generateApiKey({ length: 32, pool });
            user = await User.create(
                { name: generatedUsername, token, firebaseUid },
                { transaction },
            );

            const startingSystem = (
                await System.findAll({
                    where: { startingSystem: true },
                    transaction,
                })
            )[0];

            const inventory = await Inventory.create({}, { transaction });
            const fleet = await Fleet.create(
                {
                    ownerUserId: user.id,
                    locationSystemId: startingSystem.id,
                    inventoryId: inventory.id,
                },
                { transaction },
            );
            await FleetComposition.create(
                { fleetId: fleet.id, shipTypeId: "miner", quantity: 1 },
                { transaction },
            );
        });
    }

    res.json(serializeUserForWebsite(user));
});

const gameRouter = express.Router();

gameRouter.use(
    OpenApiValidator.middleware({
        apiSpec: "src/openapi.yaml",
        validateRequests: true,
        validateResponses: true,
    }),
);

gameRouter.use(authMiddleware);

if (NODE_ENV == "production") {
    gameRouter.use(
        rateLimit({
            windowMs: 1 * 1000, // 1 second
            limit: 5,
            standardHeaders: "draft-7",
            legacyHeaders: false,
            keyGenerator: (req, res) => res.locals.user.id,
            handler: (req, res, next, options) =>
                res.status(options.statusCode).send({
                    error: "rate_limited",
                    message: "Too much requests were sent",
                }),
        }),
    );
}

addFleetsRoutes(gameRouter);
addUsersRoutes(gameRouter);
addShipTypesRoutes(gameRouter);
addSystemsRoutes(gameRouter);
addResourcesRoutes(gameRouter);

export async function createFleet(
    ownerUserId: string,
    locationSystemId: string,
    transaction: Transaction,
): Promise<Fleet> {
    const inventory = await Inventory.create({}, { transaction });
    const fleet = await Fleet.create(
        { ownerUserId, locationSystemId, inventoryId: inventory.id },
        { transaction },
    );
    return fleet;
}

export async function changeShipsOfFleets(
    shipsToChangeOfFleets: {
        [fleetId: string]: { [shipTypeId: string]: number };
    },
    transaction: Transaction,
): Promise<boolean> {
    // Fetch all the related fleet compositions, on the right order
    let fleetCompositionsForFleets = await asyncSequentialMap(
        Object.entries(shipsToChangeOfFleets).sort(
            (a, b) => parseInt(a[0]) - parseInt(b[0]),
        ),
        async ([fleetId, shipToChange]) =>
            [
                fleetId,
                await asyncSequentialMap(
                    Object.entries(shipToChange).sort((a, b) =>
                        a[0] < b[0] ? -1 : 1,
                    ),
                    async ([shipTypeId, _]) =>
                        [
                            shipTypeId,
                            await FleetComposition.findOne({
                                where: { fleetId, shipTypeId },
                                transaction,
                                lock: true,
                            }),
                        ] as [string, FleetComposition],
                ),
            ] as [string, [string, FleetComposition | null][]],
    );

    // For negative quantities, check if there are enough quantity to remove
    const notEnoughQuantity = fleetCompositionsForFleets.some(
        ([fleetId, resourcesToChange]) =>
            resourcesToChange.some(([shipTypeId, fleetComposition]) => {
                const quantity = shipsToChangeOfFleets[fleetId][shipTypeId];

                if (quantity >= 0) {
                    return false;
                }

                return (
                    fleetComposition == null ||
                    BigInt(fleetComposition.quantity) < -quantity
                );
            }),
    );

    if (notEnoughQuantity) {
        return false;
    }

    // Create new fleet compositions for added quantities for which there is no fleet compositions
    fleetCompositionsForFleets = await Promise.all(
        fleetCompositionsForFleets.map(async ([fleetId, resourcesToChange]) => [
            fleetId,
            await Promise.all(
                resourcesToChange.map(
                    async ([shipTypeId, fleetComposition]) => {
                        return [
                            shipTypeId,
                            fleetComposition == null
                                ? await FleetComposition.create(
                                      { fleetId, shipTypeId, quantity: 0 },
                                      { transaction, lock: true },
                                  )
                                : fleetComposition,
                        ] as [string, FleetComposition];
                    },
                ),
            ),
        ]),
    );

    // Apply the changes
    await Promise.all(
        fleetCompositionsForFleets.map(
            async ([fleetId, resourcesToChange]) =>
                await Promise.all(
                    resourcesToChange.map(
                        async ([shipTypeId, fleetComposition]) => {
                            fleetComposition.quantity = (
                                BigInt(fleetComposition.quantity) +
                                BigInt(
                                    shipsToChangeOfFleets[fleetId][shipTypeId],
                                )
                            ).toString();

                            // Delete if quantity is 0
                            if (
                                BigInt(fleetComposition.quantity) == BigInt(0)
                            ) {
                                await fleetComposition.destroy({ transaction });
                            } else {
                                await fleetComposition.save({ transaction });
                            }
                        },
                    ),
                ),
        ),
    );

    // Check if fleets need to be destroyed because there is no more ships
    const fleetIdsToBeDestroyed = (
        await Promise.all(
            Object.keys(shipsToChangeOfFleets).map(async (fleetId) => {
                return await Fleet.findByPk(fleetId, {
                    transaction,
                    include: FleetComposition,
                });
            }),
        )
    )
        .filter((fleet) => fleet.fleetCompositions.length == 0)
        .map((f) => f.id);

    await Fleet.destroy({
        where: { id: fleetIdsToBeDestroyed },
        transaction,
    });

    return true;
}

export async function changeResourcesOfInventories(
    resourcesToChangeOfInventories: {
        [inventoryId: string]: { [resourceId: string]: number };
    },
    transaction: Transaction,
): Promise<boolean> {
    // Fetch all the related inventory items, on the right order
    let inventoryItemsForInventories = await asyncSequentialMap(
        Object.entries(resourcesToChangeOfInventories).sort(
            (a, b) => parseInt(a[0]) - parseInt(b[0]),
        ),
        async ([inventoryId, resourcesToChange]) =>
            [
                inventoryId,
                await asyncSequentialMap(
                    Object.entries(resourcesToChange).sort((a, b) =>
                        a[0] < b[0] ? -1 : 1,
                    ),
                    async ([resourceId, _]) =>
                        [
                            resourceId,
                            await InventoryItem.findOne({
                                where: { inventoryId, resourceId },
                                transaction,
                                lock: true,
                            }),
                        ] as [string, InventoryItem],
                ),
            ] as [string, [string, InventoryItem | null][]],
    );

    // For negative quantities, check if there are enough quantity to remove
    const notEnoughQuantity = inventoryItemsForInventories.some(
        ([inventoryId, resourcesToChange]) =>
            resourcesToChange.some(([resourceId, inventoryItem]) => {
                const quantity =
                    resourcesToChangeOfInventories[inventoryId][resourceId];

                if (quantity >= 0) {
                    return false;
                }

                return (
                    inventoryItem == null ||
                    BigInt(inventoryItem.quantity) < -quantity
                );
            }),
    );

    if (notEnoughQuantity) {
        return false;
    }

    // Create new inventory items for added quantities for which there is no inventory items
    inventoryItemsForInventories = await Promise.all(
        inventoryItemsForInventories.map(
            async ([inventoryId, resourcesToChange]) => [
                inventoryId,
                await Promise.all(
                    resourcesToChange.map(
                        async ([resourceId, inventoryItem]) => {
                            return [
                                resourceId,
                                inventoryItem == null
                                    ? await InventoryItem.create(
                                          {
                                              inventoryId,
                                              resourceId,
                                              quantity: 0,
                                          },
                                          { transaction },
                                      )
                                    : inventoryItem,
                            ] as [string, InventoryItem];
                        },
                    ),
                ),
            ],
        ),
    );

    // Apply the changes
    await Promise.all(
        inventoryItemsForInventories.map(
            async ([inventoryId, resourcesToChange]) =>
                await Promise.all(
                    resourcesToChange.map(
                        async ([resourceId, inventoryItem]) => {
                            inventoryItem.quantity = (
                                BigInt(inventoryItem.quantity) +
                                BigInt(
                                    resourcesToChangeOfInventories[inventoryId][
                                        resourceId
                                    ],
                                )
                            ).toString();

                            // Delete if quantity is 0
                            if (BigInt(inventoryItem.quantity) == BigInt(0)) {
                                await inventoryItem.destroy({ transaction });
                            } else {
                                await inventoryItem.save({ transaction });
                            }
                        },
                    ),
                ),
        ),
    );

    return true;
}

const scheduledTaskTimeouts: NodeJS.Timeout[] = [];

function secheduleDelayedTask(executionTime: Date, task: () => void) {
    const delay = Math.max(0, executionTime.getTime() - Date.now());

    const taskTimeout = setTimeout(() => {
        _.pull(scheduledTaskTimeouts, taskTimeout);

        traceIdStore.run(v4(), task);
    }, delay);

    scheduledTaskTimeouts.push(taskTimeout);
}

export function unscheduleAllDelayedTasks() {
    scheduledTaskTimeouts.map((taskTimeout) => clearTimeout(taskTimeout));
}

export function scheduleFleetArrival(fleetId: string, arrivalTime: Date) {
    secheduleDelayedTask(arrivalTime, async () => {
        await setupTransaction(sequelize, async (transaction) => {
            LOGGER.info("fleet arrival begin", { fleetId });
            const fleet = await Fleet.findByPk(fleetId, {
                transaction,
                lock: true,
            });

            const destinationSystemId = fleet.travelingToSystemId;

            if (destinationSystemId == null) {
                LOGGER.error("destinationSystemId null", { fleetId });
                throw new Error();
            }

            if (fleet.currentAction != "traveling") {
                LOGGER.error("fleet's current action is not traveling", {
                    fleetId,
                    currentAction: fleet.currentAction,
                });
                throw new Error();
            }

            fleet.currentAction = "idling";
            fleet.travelingFromSystemId = null;
            fleet.travelingToSystemId = null;
            fleet.arrivalTime = null;
            fleet.departureTime = null;
            fleet.locationSystemId = destinationSystemId;

            await fleet.save({ transaction });

            LOGGER.info("fleet arrival end", { fleetId });
        });
    });
}

export function scheduleMiningFinish(fleetId: string, miningFinishTime: Date) {
    secheduleDelayedTask(miningFinishTime, async () => {
        await setupTransaction(sequelize, async (transaction) => {
            LOGGER.info("mining finish begin", { fleetId });
            const fleet = await Fleet.findByPk(fleetId, {
                transaction,
                lock: true,
                include: [
                    {
                        model: FleetComposition,
                        required: true,
                        include: [{ model: ShipType, required: true }],
                    },
                    { model: Inventory, required: true },
                ],
            });

            // Get resource mined
            const miningResourceId = fleet.miningResourceId;

            if (fleet.currentAction != "mining") {
                LOGGER.error("fleet's current action is not mining", {
                    fleetId,
                    currentAction: fleet.currentAction,
                });
                throw new Error();
            }

            // Get mining power of fleet
            const miningPower = Number(
                fleet.fleetCompositions.reduce(
                    (p, c) =>
                        p + BigInt(c.quantity) * BigInt(c.shipType.miningPower),
                    BigInt(0),
                ),
            );

            const resourceMined = {
                [miningResourceId]: miningPower,
            };

            await changeResourcesOfInventories(
                { [fleet.inventoryId]: resourceMined },
                transaction,
            );

            fleet.currentAction = "idling";
            fleet.miningFinishTime = null;

            await fleet.save({ transaction });
            LOGGER.info("mining finish end", { fleetId });
        });
    });
}

export async function launchDelayedTasks() {
    // Launch all delayed events:
    // Traveling fleets
    const travelingFleets = await Fleet.findAll({
        where: { currentAction: "traveling" },
    });

    travelingFleets.forEach((fleet) => {
        scheduleFleetArrival(fleet.id, fleet.arrivalTime);
    });

    // Mining fleets
    const miningFleets = await Fleet.findAll({
        where: { currentAction: "mining" },
    });

    miningFleets.forEach((fleet) => {
        scheduleMiningFinish(fleet.id, fleet.miningFinishTime);
    });
}

app.use(express.json());

app.use(loggerMiddleware);

app.use((req, res, next) => {
    LOGGER.info("new request", {
        originalUrl: req.originalUrl,
        body: req.body,
    });
    next();
});

app.use(express.static("public"));
app.use("/openapi.yaml", express.static("src/openapi.yaml"));
app.use(
    "/docs",
    swaggerUI.serve,
    swaggerUI.setup(YAML.parse(fs.readFileSync("src/openapi.yaml", "utf8"))),
);

app.use("/v1", nonGameRouter);
app.use("/v1", gameRouter);

app.use((err, req, res, next) => {
    let httpStatusCode = 0;
    let errorCode = "";
    let message = "";
    let additionalFields = {};

    if (err instanceof HttpError) {
        httpStatusCode = err.httpStatusCode;
        errorCode = err.errorCode;
        message = err.message;

        LOGGER.child({ traceId: res.locals.traceId }).info(
            "HttpError occured",
            err,
        );
    } else if (err.errors && err.status) {
        if (err.status == 500) {
            httpStatusCode = 500;
            errorCode = "internal_error";
            message = "An internal error occured.";

            LOGGER.child({ traceId: res.locals.traceId }).error(err);
        } else {
            httpStatusCode = err.status;
            errorCode = "validation_error";
            message = err.message;
            additionalFields = {
                errors: err.errors,
            };

            LOGGER.child({ traceId: res.locals.traceId }).info(
                "request validation error occured",
                err,
            );
        }
    } else {
        httpStatusCode = 500;
        errorCode = "internal_error";
        message = "An internal error occured.";

        LOGGER.child({ traceId: res.locals.traceId }).error(err);
    }

    res.status(httpStatusCode).send({
        error: errorCode,
        message,
        ...additionalFields,
    });

    next();
});

export default app;
