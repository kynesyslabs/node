/* eslint-disable no-case-declarations */
import { EventEmitter } from "events"

type MsgType = "MsgPrePrepare" | "MsgPrepare" | "MsgCommit" | "MsgRoundChange"

type UponRule =
    | "uponUnknown"
    | "uponValidPrePrepare"
    | "uponQuorumPrepare"
    | "uponQuorumCommit"
    | "uponMinRoundChange"
    | "uponQuorumRoundChange"

interface Transport {
    // eslint-disable-next-line no-unused-vars
    Broadcast: (msg: Msg) => void
    Receive: EventEmitter // Using EventEmitter for message reception in TypeScript.
}

interface Defs {
    // eslint-disable-next-line no-unused-vars
    IsLeader: (instance: bigint, round: bigint, process: bigint) => boolean
    // eslint-disable-next-line no-unused-vars
    NewTimer: (round: bigint) => [NodeJS.Timeout, () => void]
    // eslint-disable-next-line no-unused-vars
    IsValid: (instance: bigint, msg: Msg) => boolean
    LogUponRule: (
        // eslint-disable-next-line no-unused-vars
        instance: bigint,
        // eslint-disable-next-line no-unused-vars
        process: bigint,
        // eslint-disable-next-line no-unused-vars
        round: bigint,
        // eslint-disable-next-line no-unused-vars
        msg: Msg,
        // eslint-disable-next-line no-unused-vars
        uponRule: UponRule,
    ) => void
    Quorum: bigint
    Faulty: bigint
}

interface Msg {
    UUID?: string
    Type: MsgType
    Instance: bigint
    Source: bigint
    Round: bigint
    Value: Buffer
    PreparedRound: bigint
    PreparedValue: Buffer
    RawMsg?: Buffer[]
}

export default class QBFT {
    static async Run(
        ctx: { done: Promise<void> },
        d: Defs,
        t: Transport,
        instance: bigint,
        process: bigint,
        inputValue: Buffer,
    ): Promise<[Buffer, Error]> {
        if (inputValue === null) {
            throw new Error("nil input value not supported")
        }

        try {
            // === Helpers ===

            const broadcastMsg = (
                typ: MsgType,
                round: bigint,
                value: Buffer,
            ) => {
                t.Broadcast({
                    Type: typ,
                    Instance: instance,
                    Source: process,
                    Round: round,
                    Value: value,
                    PreparedRound: undefined,
                    PreparedValue: undefined,
                })
            }

            const broadcastRoundChange = (
                round: bigint,
                pr: bigint,
                pv: Buffer,
            ) => {
                t.Broadcast({
                    Type: "MsgRoundChange" as MsgType,
                    Instance: instance,
                    Source: process,
                    Round: round,
                    PreparedRound: pr,
                    PreparedValue: pv,
                    Value: undefined,
                })
            }

            // === State ===

            let round: bigint = BigInt(1)
            let preparedRound: bigint = BigInt(0)
            let preparedValue: Buffer | null = null
            let msgs: Msg[] = []
            // let dedup: Map<DedupKey, boolean> = new Map()
            let dedup: Map<string, boolean> = new Map()

            let timerChan: Promise<void> | null
            let stopTimer: (() => void) | null

            // === Algorithm ===

            if (d.IsLeader(instance, BigInt(1), process)) {
                broadcastMsg("MsgPrePrepare", BigInt(1), inputValue)
            }

            ;[timerChan, stopTimer] = d.NewTimer(BigInt(1))

            // Handle events until finished.
            let conditioner = true
            while (conditioner) {
                let msgEvent = t.Receive as EventEmitter
                let msg = await new Promise<Msg | null>(resolve => {
                    msgEvent.once("message", message => {
                        resolve(message)
                    })
                    ctx.done.then(() => resolve(null))
                })

                if (msg === null) {
                    // context closed
                    throw ctx.done
                }

                if (dedup.get(this.key(msg))) {
                    continue
                }
                dedup.set(this.key(msg), true)

                if (!d.IsValid(instance, msg)) {
                    continue
                }

                msgs.push(msg)

                let [rule, ok] = QBFT.classify(
                    d,
                    instance,
                    round,
                    process,
                    msgs,
                    msg,
                )
                if (!ok) {
                    continue
                }

                d.LogUponRule(
                    instance,
                    process,
                    round,
                    msg,
                    rule.toString() as UponRule,
                )

                let qrc
                let pv
                let value

                switch (rule) {
                    case "uponValidPrePrepare":
                        if (stopTimer) {
                            stopTimer()
                        }
                        ;[timerChan, stopTimer] = d.NewTimer(round)
                        broadcastMsg("MsgPrepare", msg.Round, msg.Value)
                        break

                    case "uponQuorumPrepare":
                        preparedRound = msg.Round
                        preparedValue = msg.Value
                        broadcastMsg("MsgCommit", msg.Round, msg.Value)
                        break

                    case "uponQuorumCommit":
                        if (stopTimer) stopTimer()
                        return [msg.Value, null]

                    case "uponMinRoundChange":
                        round = QBFT.nextMinRound(d, msgs, round)
                        if (stopTimer) stopTimer()
                        ;[timerChan, stopTimer] = d.NewTimer(round)
                        broadcastRoundChange(
                            round,
                            preparedRound,
                            preparedValue,
                        )
                        break

                    case "uponQuorumRoundChange":
                        qrc = QBFT.filterRoundChange(msgs, msg.Round)
                        pv = QBFT.highestPrepared(qrc)
                        value = pv ? pv : inputValue
                        broadcastMsg("MsgPrePrepare", round, value)
                        break

                    default:
                        throw new Error("bug: invalid rule")
                }

                if (timerChan) {
                    await timerChan
                    round++
                    if (stopTimer) stopTimer()
                    ;[timerChan, stopTimer] = d.NewTimer(round)
                    broadcastRoundChange(round, preparedRound, preparedValue)
                }
            }
        } catch (error) {
            return [null, error]
        }
    }

    static classify(
        d: Defs,
        instance: bigint,
        round: bigint,
        process: bigint,
        msgs: Msg[],
        msg: Msg,
    ): [UponRule, boolean] {
        switch (msg.Type) {
            case "MsgPrePrepare":
                if (msg.Round < round) {
                    return ["uponUnknown", false]
                }
                if (this.justifyPrePrepare(d, instance, msgs, msg)) {
                    return ["uponValidPrePrepare", true]
                }
                break
            case "MsgPrepare":
                if (msg.Round !== round) {
                    return ["uponUnknown", false]
                }
                const prepareCount = this.countByValue(
                    msgs,
                    "MsgPrepare",
                    msg.Round,
                    msg.Value,
                )
                if (prepareCount >= BigInt(d.Quorum)) {
                    return ["uponQuorumPrepare", true]
                }
                break
            case "MsgCommit":
                const commitCount = this.countByValue(
                    msgs,
                    "MsgCommit",
                    msg.Round,
                    msg.Value,
                )
                if (commitCount >= BigInt(d.Quorum)) {
                    return ["uponQuorumCommit", true]
                }
                break
            case "MsgRoundChange":
                const frc = this.filterHigherRoundChange(msgs, round)
                if (BigInt(frc.length) === BigInt(d.Faulty) + BigInt(1)) {
                    return ["uponMinRoundChange", true]
                }

                const qrc = this.filterRoundChange(msgs, round)
                if (
                    msg.Round === round &&
                    qrc.length >= BigInt(d.Quorum) &&
                    d.IsLeader(instance, msg.Round, process) &&
                    this.justifyRoundChange(d, msgs, qrc)
                ) {
                    return ["uponQuorumRoundChange", true]
                }

                return ["uponUnknown", false]
            default:
                throw new Error("bug: invalid type")
        }

        return ["uponUnknown", false]
    }

    static highestPrepared(qrc: Msg[]): [bigint, Uint8Array | null] {
        if (qrc.length === 0) {
            throw new Error("bug: qrc empty")
        }

        let pr = BigInt(0)
        let pv: Uint8Array | null = null

        for (let msg of qrc) {
            if (pr < msg.PreparedRound) {
                pr = msg.PreparedRound
                pv = msg.PreparedValue
            }
        }

        return [pr, pv]
    }

    static nextMinRound(d: Defs, msgs: Msg[], round: bigint): bigint {
        const frc = this.filterHigherRoundChange(msgs, round)
        if (frc.length < BigInt(d.Faulty) + BigInt(1)) {
            throw new Error("bug: too few round change messages")
        }

        let rmin = BigInt(Number.MAX_SAFE_INTEGER)

        for (let msg of frc) {
            if (rmin > msg.Round) {
                rmin = msg.Round
            }
        }

        return rmin
    }

    static justifyRoundChange(d: Defs, all: Msg[], qrc: Msg[]): boolean {
        if (qrc.length < BigInt(d.Quorum)) return false

        if (this.qrcNoPrepared(qrc)) return true

        const [_, ok] = this.qrcHighestPrepared(d, all, qrc)
        return ok
    }

    static justifyPrePrepare(
        d: Defs,
        instance: bigint,
        msgs: Msg[],
        msg: Msg,
    ): boolean {
        if (msg.Type !== ("MsgPrePrepare" as MsgType)) {
            throw new Error("bug: not a preprepare message")
        }

        if (!d.IsLeader(instance, msg.Round, msg.Source)) return false

        if (msg.Round === BigInt(1)) return true

        const qrc = this.filterRoundChange(msgs, msg.Round)
        if (qrc.length < BigInt(d.Quorum)) return false

        if (this.qrcNoPrepared(qrc)) return true

        const [pv, ok] = this.qrcHighestPrepared(d, msgs, qrc)
        if (!ok) return false
        if (!this.areArraysEqual(pv, msg.Value)) return false // Use utility function

        return true
    }

    static qrcNoPrepared(qrc: Msg[]): boolean {
        for (let msg of qrc) {
            if (msg.Type !== ("MsgRoundChange" as MsgType)) {
                throw new Error("bug: invalid Qrc set")
            }
            if (msg.PreparedRound !== BigInt(0) || msg.PreparedValue) {
                return false
            }
        }
        return true
    }

    static qrcHighestPrepared(
        d: Defs,
        all: Msg[],
        qrc: Msg[],
    ): [Uint8Array, boolean] {
        const [pr, pv] = this.highestPrepared(qrc)
        if (pr === BigInt(0)) {
            return [new Uint8Array(), false]
        }

        if (
            this.countByValue(all, "MsgPrepare" as MsgType, pv) <
            BigInt(d.Quorum)
        ) {
            return [new Uint8Array(), false]
        }

        return [pv, true]
    }

    static countByValue(
        msgs: Msg[],
        typ: MsgType,
        round: bigint,
        value: bigint,
    ): bigint {
        // Modify the function to process the 'round' argument
        return BigInt(this.filterMsgs(msgs, typ, round, value).length)
    }

    static filterRoundChange(msgs: Msg[], round: bigint): Msg[] {
        return this.filterMsgs(msgs, "MsgRoundChange" as MsgType, round)
    }

    static filterHigherRoundChange(msgs: Msg[], round: bigint): Msg[] {
        const resp: Msg[] = []
        for (let msg of this.filterMsgs(msgs, "MsgRoundChange" as MsgType)) {
            if (msg.Round <= round) continue
            resp.push(msg)
        }
        return resp
    }

    static filterMsgs(
        msgs: Msg[],
        typ: MsgType,
        round?: bigint,
        value?: Uint8Array,
        pr?: bigint,
        pv?: Uint8Array,
    ): Msg[] {
        const resp: Msg[] = []
        const dups: { [key: string]: boolean } = {}

        for (let msg of msgs) {
            if (typ !== msg.Type) continue

            if (round && round !== msg.Round) continue

            if (value && !this.areArraysEqual(value, msg.Value)) continue

            if (pv && !this.areArraysEqual(pv, msg.PreparedValue)) continue

            if (pr && pr !== msg.PreparedRound) continue

            if (dups[this.key(msg)]) continue

            dups[this.key(msg)] = true
            resp.push(msg)
        }

        return resp
    }

    static key(msg: Msg): string {
        return `${msg.Source}-${msg.Type}-${msg.Round}`
    }

    // Helper function to check if Uint8Arrays are equal
    static areArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
        return (
            a.length === b.length && a.every((val, index) => val === b[index])
        )
    }
}
