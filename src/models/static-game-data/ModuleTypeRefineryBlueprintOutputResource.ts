import { BelongsTo, ForeignKey, Model } from "sequelize-typescript";
import { Column, PrimaryKey, Table } from "sequelize-typescript";
import ModuleTypeRefineryBlueprint from "./ModuleTypeRefineryBlueprint";
import Resource from "./Resource";

@Table({ modelName: "ModuleTypeRefineryRecipeOutputResources" })
export default class ModuleTypeRefineryBlueprintOutputResource extends Model {
    @PrimaryKey
    @ForeignKey(() => ModuleTypeRefineryBlueprint)
    @Column
    declare moduleTypeRefineryBlueprintId: string;

    @BelongsTo(() => ModuleTypeRefineryBlueprint)
    moduleTypeRefineryBlueprint: ModuleTypeRefineryBlueprint;

    @PrimaryKey
    @ForeignKey(() => Resource)
    @Column
    declare resourceId: string;

    @Column
    declare quantity: number;
}
