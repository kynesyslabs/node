import { Column, Entity } from "typeorm";

@Entity("responseRegistry")
export class ResponseRegistry {
  @Column("text", { name: "muid", nullable: true })
  muid: string | null;

  @Column("integer", { name: "timestamp", nullable: true })
  timestamp: number | null;

  @Column("text", { name: "response", nullable: true })
  response: string | null;

  @Column("text", { name: "comlink", nullable: true })
  comlink: string | null;
}
