import { Column, Entity, PrimaryColumn } from "typeorm"

@Entity("response_registry")
export class ResponseRegistry {
    @PrimaryColumn("text", { name: "muid" })
    muid: string | null

    @Column("integer", { name: "timestamp", nullable: true })
    timestamp: number | null

    @Column("text", { name: "response", nullable: true })
    response: string | null

    @Column("text", { name: "comlink", nullable: true })
    comlink: string | null
}
