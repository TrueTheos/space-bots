import { User } from "../database";
import logger from "./logger";
import moduleName from "./moduleName";
import { Request, Response } from "express";

const LOGGER = logger(moduleName(__filename));

export default async function authMiddleware(
    req: Request,
    res: Response,
    next: any,
) {
    try {
        if (!req.get("Authorization")) {
            res.status(401).json({ status: "unauthorized" });
            return;
        }
        const token = req.get("Authorization").substring("Bearer ".length);

        const user = await User.findOne({ where: { token } });

        if (user == null) {
            res.status(401).json({ status: "unauthorized" });
            return;
        }

        LOGGER.info("user authenticated", { userId: user.id });

        res.locals.user = user;

        next();
    } catch (e) {
        next(e);
    }
}
