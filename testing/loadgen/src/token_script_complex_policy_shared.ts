type ComplexPolicyScriptParams = {
  allowlist: string[]
  denylist: string[]
  quotaPerBucket: number
  bucketMs: number
  amountLimit: bigint
  feeThreshold: bigint
  feeFixed: bigint
  feeSink: string | null
  escrow?: {
    vault: string
  }
  vesting?: {
    schedules: Record<
      string,
      {
        total: bigint
      }
    >
  }
  debugCapture?: boolean
  dynamicPolicy?: {
    admin: string
    commandBase: bigint
    presets: Record<
      string,
      Partial<{
        allowlist: string[]
        denylist: string[]
        quotaPerBucket: number
        bucketMs: number
        amountLimit: bigint
        feeThreshold: bigint
        feeFixed: bigint
        feeSink: string | null
        escrow: {
          vault: string
        }
        vesting: {
          schedules: Record<string, { total: bigint }>
        }
      }>
    >
    vestingUnlocks?: Record<
      string,
      {
        address: string
        addUnlocked: bigint
      }
    >
    escrowCmds?: Record<
      string,
      {
        type: "setBeneficiary" | "approveRelease" | "approveRefund"
        id: number
        beneficiary?: string
      }
    >
  }
}

function normHex(address: string): string {
  const trimmed = (address ?? "").trim().toLowerCase()
  if (!trimmed) return trimmed
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`
}

function jsArrayOfStrings(values: string[]): string {
  return `[${values.map(v => JSON.stringify(v)).join(", ")}]`
}

function jsBigintLiteral(value: bigint): string {
  // Script runtime supports BigInt (used throughout existing token_script_* scenarios).
  return `${value.toString()}n`
}

function jsVestingSchedulesObject(
  schedules: Record<string, { total: bigint }>,
): string {
  const entries: string[] = []
  for (const [addr, sched] of Object.entries(schedules ?? {})) {
    const a = normHex(addr)
    if (!a) continue
    const total = typeof sched?.total === "bigint" ? sched.total : 0n
    entries.push(`${JSON.stringify(a)}: { total: ${jsBigintLiteral(total)} }`)
  }
  return `{ ${entries.join(", ")} }`
}

function jsPolicyOverrideObject(value: any): string {
  if (!value || typeof value !== "object") return "{}"
  const entries: string[] = []

  if (Array.isArray(value.allowlist)) entries.push(`allowlist: ${jsArrayOfStrings(value.allowlist)}`)
  if (Array.isArray(value.denylist)) entries.push(`denylist: ${jsArrayOfStrings(value.denylist)}`)
  if (typeof value.quotaPerBucket === "number") entries.push(`quotaPerBucket: ${Math.max(0, Math.floor(value.quotaPerBucket))}`)
  if (typeof value.bucketMs === "number") entries.push(`bucketMs: ${Math.max(1, Math.floor(value.bucketMs))}`)
  if (typeof value.amountLimit === "bigint") entries.push(`amountLimit: ${jsBigintLiteral(value.amountLimit)}`)
  if (typeof value.feeThreshold === "bigint") entries.push(`feeThreshold: ${jsBigintLiteral(value.feeThreshold)}`)
  if (typeof value.feeFixed === "bigint") entries.push(`feeFixed: ${jsBigintLiteral(value.feeFixed)}`)
  if (typeof value.feeSink === "string") entries.push(`feeSink: ${JSON.stringify(normHex(value.feeSink))}`)
  if (value.feeSink === null) entries.push("feeSink: null")
  if (value.vesting && typeof value.vesting === "object" && value.vesting.schedules && typeof value.vesting.schedules === "object") {
    entries.push(`vesting: { schedules: ${jsVestingSchedulesObject(value.vesting.schedules)} }`)
  }

  return `{ ${entries.join(", ")} }`
}

export function buildComplexPolicyScript(params: ComplexPolicyScriptParams): string {
  const allow = params.allowlist.map(normHex).filter(Boolean)
  const deny = params.denylist.map(normHex).filter(Boolean)

  const quota = Math.max(0, Math.floor(params.quotaPerBucket))
  const bucketMs = Math.max(1, Math.floor(params.bucketMs))

  const feeSink = params.feeSink ? normHex(params.feeSink) : null

  const escrowVault = params.escrow?.vault ? normHex(params.escrow.vault) : null

  const vestingSchedules = params.vesting?.schedules ?? {}

  const dynamicPolicy = params.dynamicPolicy
    ? {
        admin: normHex(params.dynamicPolicy.admin),
        commandBase: params.dynamicPolicy.commandBase,
        presets: Object.fromEntries(
          Object.entries(params.dynamicPolicy.presets ?? {}).map(([k, v]) => [String(k), v]),
        ) as Record<string, any>,
        vestingUnlocks: Object.fromEntries(
          Object.entries(params.dynamicPolicy.vestingUnlocks ?? {}).map(([k, v]) => [
            String(k),
            { address: normHex(v.address), addUnlocked: v.addUnlocked },
          ]),
        ) as Record<string, any>,
        escrowCmds: Object.fromEntries(
          Object.entries(params.dynamicPolicy.escrowCmds ?? {}).map(([k, v]) => [
            String(k),
            {
              type: String(v.type),
              id: Math.max(0, Math.floor(Number(v.id))),
              beneficiary: v.beneficiary ? normHex(v.beneficiary) : null,
            },
          ]),
        ) as Record<string, any>,
      }
    : null

  const lines: string[] = [
    "function normHex(a) {",
    "  const s = String(a ?? '').trim().toLowerCase();",
    "  if (!s) return s;",
    "  return s.startsWith('0x') ? s : ('0x' + s);",
    "}",
    "",
    "function parseBigint(v) {",
    "  try {",
    "    if (typeof v === 'bigint') return v;",
    "    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(v);",
    "    return BigInt(String(v ?? '0'));",
    "  } catch {",
    "    return 0n;",
    "  }",
    "}",
    "",
    "function getCaller(ctx) {",
    "  return normHex(",
    "    ctx?.caller ??",
    "    ctx?.operationContext?.caller ??",
    "    ctx?.operationData?.caller ??",
    "    ctx?.operationData?.from ??",
    "    ctx?.operationData?.fromHex ??",
    "    ctx?.from ??",
    "    ctx?.tx?.from ??",
    "    ''",
    "  );",
    "}",
    "",
    "function getTo(ctx) {",
    "  return normHex(",
    "    ctx?.operationData?.to ??",
    "    ctx?.operationData?.toHex ??",
    "    ctx?.to ??",
    "    ''",
    "  );",
    "}",
    "",
    "function getBucket(ctx, bucketMs) {",
    "  const ts = ctx?.operationContext?.txTimestamp ?? ctx?.txTimestamp ?? ctx?.operationData?.timestamp ?? ctx?.tx?.content?.timestamp ?? null;",
    "  const n = typeof ts === 'number' && Number.isFinite(ts) ? ts : (typeof ts === 'string' ? Number.parseInt(ts, 10) : null);",
    "  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;",
    "  const ms = typeof bucketMs === 'number' && Number.isFinite(bucketMs) ? bucketMs : Number.parseInt(String(bucketMs ?? '0'), 10);",
    "  const denom = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 1;",
    "  return Math.floor(n / denom);",
    "}",
    "",
    "function incInt(obj, key, by) {",
    "  const base = obj && typeof obj === 'object' ? obj : {};",
    "  const cur = Number(base[key] || 0);",
    "  const next = (Number.isFinite(cur) ? cur : 0) + Number(by || 1);",
    "  return { ...base, [key]: next };",
    "}",
    "",
    "function incBigintStr(obj, key, by) {",
    "  const base = obj && typeof obj === 'object' ? obj : {};",
    "  let cur = 0n;",
    "  try { cur = BigInt(String(base[key] ?? '0')); } catch { cur = 0n; }",
    "  const next = cur + parseBigint(by);",
    "  return { ...base, [key]: next.toString() };",
    "}",
    "",
    "function updateNestedIntMap(root, addr, bucket, by) {",
    "  const base = root && typeof root === 'object' ? root : {};",
    "  const a = String(addr ?? '');",
    "  const curMap = base[a] && typeof base[a] === 'object' ? base[a] : {};",
    "  const cur = Number(curMap[String(bucket)] || 0);",
    "  const next = (Number.isFinite(cur) ? cur : 0) + Number(by || 1);",
    "  return { ...base, [a]: { ...curMap, [String(bucket)]: next } };",
    "}",
    "",
    "function escrowInit(storage) {",
    "  const st = storage && typeof storage === 'object' ? storage : {};",
    "  const e = st.escrow && typeof st.escrow === 'object' ? st.escrow : {};",
    "  const entries = e.entries && typeof e.entries === 'object' ? e.entries : {};",
    "  const rawNextId = e.nextId ?? 0;",
    "  const nextId = Number.isFinite(Number(rawNextId)) ? Math.max(0, Math.floor(Number(rawNextId))) : 0;",
    "  return { nextId, entries };",
    "}",
    "",
    "function escrowGetEntry(escrow, id) {",
    "  const key = String(id ?? '');",
    "  const raw = escrow && escrow.entries && typeof escrow.entries === 'object' ? escrow.entries[key] : null;",
    "  return raw && typeof raw === 'object' ? raw : null;",
    "}",
    "",
    "function escrowSetEntry(escrow, id, entry) {",
    "  const base = escrow && typeof escrow === 'object' ? escrow : { nextId: 0, entries: {} };",
    "  const entries = base.entries && typeof base.entries === 'object' ? base.entries : {};",
    "  return { ...base, entries: { ...entries, [String(id)]: entry } };",
    "}",
    "",
    "function escrowRemaining(entry) {",
    "  const total = parseBigint(entry?.total ?? 0);",
    "  const released = parseBigint(entry?.released ?? 0);",
    "  return total > released ? (total - released) : 0n;",
    "}",
    "",
    "function escrowFindMatch(escrow, to, amount) {",
    "  const e = escrow && typeof escrow === 'object' ? escrow : { nextId: 0, entries: {} };",
    "  const n = Number.isFinite(Number(e.nextId)) ? Math.max(0, Math.floor(Number(e.nextId))) : 0;",
    "  for (let i = 1; i <= n; i++) {",
    "    const entry = escrowGetEntry(e, i);",
    "    if (!entry) continue;",
    "    const status = String(entry.status || '');",
    "    const rem = escrowRemaining(entry);",
    "    if (amount > rem) continue;",
    "    if (status === 'release_approved' && normHex(entry.beneficiary || '') === to) return { id: i, kind: 'release' };",
    "    if (status === 'refund_approved' && normHex(entry.depositor || '') === to) return { id: i, kind: 'refund' };",
    "  }",
    "  return null;",
    "}",
    "",
    "const POLICY_DEFAULT = {",
    `  allowlist: ${jsArrayOfStrings(allow)},`,
    `  denylist: ${jsArrayOfStrings(deny)},`,
    `  quotaPerBucket: ${quota},`,
    `  bucketMs: ${bucketMs},`,
    `  amountLimit: ${jsBigintLiteral(params.amountLimit)},`,
    `  feeThreshold: ${jsBigintLiteral(params.feeThreshold)},`,
    `  feeFixed: ${jsBigintLiteral(params.feeFixed)},`,
    `  feeSink: ${feeSink ? JSON.stringify(feeSink) : "null"},`,
    `  vesting: { schedules: ${jsVestingSchedulesObject(vestingSchedules)} },`,
    "};",
    "",
    `const DEBUG_CAPTURE = ${params.debugCapture ? "true" : "false"};`,
    "",
    `const ESCROW = ${escrowVault ? `{ enabled: true, vault: ${JSON.stringify(escrowVault)} }` : "null"};`,
    "",
  ]

  if (dynamicPolicy) {
    lines.push(
      "const DYNAMIC = {",
      "  enabled: true,",
      `  admin: ${JSON.stringify(dynamicPolicy.admin)},`,
      `  commandBase: ${jsBigintLiteral(dynamicPolicy.commandBase)},`,
      "  presets: {",
      ...Object.entries(dynamicPolicy.presets).map(([k, v]) => `    ${JSON.stringify(k)}: ${jsPolicyOverrideObject(v)},`),
      "  },",
      "  vestingUnlocks: {",
      ...Object.entries(dynamicPolicy.vestingUnlocks ?? {}).map(
        ([k, v]) =>
          `    ${JSON.stringify(k)}: { address: ${JSON.stringify((v as any).address)}, addUnlocked: ${jsBigintLiteral(
            (v as any).addUnlocked as bigint,
          )} },`,
      ),
      "  },",
      "  escrowCmds: {",
      ...Object.entries(dynamicPolicy.escrowCmds ?? {}).map(([k, v]) => {
        const beneficiary = (v as any).beneficiary ? JSON.stringify((v as any).beneficiary) : "null"
        return `    ${JSON.stringify(k)}: { type: ${JSON.stringify((v as any).type)}, id: ${JSON.stringify(
          (v as any).id,
        )}, beneficiary: ${beneficiary} },`
      }),
      "  },",
      "};",
      "",
    )
  } else {
    lines.push("const DYNAMIC = null;", "")
  }

  lines.push(
    "function asSet(list) {",
    "  const out = {};",
    "  for (const v of Array.isArray(list) ? list : []) out[normHex(v)] = true;",
    "  return out;",
    "}",
    "",
    "function pickPolicy(storage) {",
    "  const st = storage && typeof storage === 'object' ? storage : {};",
    "  const override = st.policyOverride && typeof st.policyOverride === 'object' ? st.policyOverride : null;",
    "  const base = st.policy && typeof st.policy === 'object' ? st.policy : POLICY_DEFAULT;",
    "  return override ? { ...base, ...override } : base;",
    "}",
    "",
    "function policyToCanonical(policy) {",
    "  const p = policy && typeof policy === 'object' ? policy : {};",
    "  const v = p.vesting && typeof p.vesting === 'object' ? p.vesting : {};",
    "  const schedules = v.schedules && typeof v.schedules === 'object' ? v.schedules : {};",
    "  const schedulesOut = {};",
    "  for (const k of Object.keys(schedules)) {",
    "    const s = schedules[k] && typeof schedules[k] === 'object' ? schedules[k] : {};",
    "    schedulesOut[normHex(k)] = { total: parseBigint(s.total ?? 0) };",
    "  }",
    "  return {",
    "    allowlist: Array.isArray(p.allowlist) ? p.allowlist.map(normHex) : [],",
    "    denylist: Array.isArray(p.denylist) ? p.denylist.map(normHex) : [],",
    "    quotaPerBucket: Number.isFinite(Number(p.quotaPerBucket)) ? Math.max(0, Math.floor(Number(p.quotaPerBucket))) : 0,",
    "    bucketMs: Number.isFinite(Number(p.bucketMs)) ? Math.max(1, Math.floor(Number(p.bucketMs))) : 1,",
    "    amountLimit: parseBigint(p.amountLimit ?? 0),",
    "    feeThreshold: parseBigint(p.feeThreshold ?? 0),",
    "    feeFixed: parseBigint(p.feeFixed ?? 0),",
    "    feeSink: p.feeSink ? normHex(p.feeSink) : null,",
    "    vesting: { schedules: schedulesOut },",
    "  };",
    "}",
    "",
    "// NOTE: Script hook context currently exposes only operationData.{from,to,amount} (no timestamp, nonce, or block).",
    "",
    "function applyPolicy(ctx, hook) {",
    "  const caller = getCaller(ctx);",
    "  const to = getTo(ctx);",
    "  const amount = parseBigint(ctx?.operationData?.amount ?? 0);",
    "  const isBefore = String(hook || '').startsWith('before');",
    "",
    "  const storage = ctx?.token?.storage && typeof ctx.token.storage === 'object' ? ctx.token.storage : {};",
    "  const counts = storage.counts && typeof storage.counts === 'object' ? storage.counts : {};",
    "  const rejections = storage.rejections && typeof storage.rejections === 'object' ? storage.rejections : {};",
    "  const quotas = storage.quotas && typeof storage.quotas === 'object' ? storage.quotas : {};",
    "  const fees = storage.fees && typeof storage.fees === 'object' ? storage.fees : {};",
    "",
    "  const counts2 = incInt(counts, hook, 1);",
    "",
    "  const effective = policyToCanonical(pickPolicy(storage));",
    "  const bucket = getBucket(ctx, effective.bucketMs);",
    "  const nowRef = 0;",
    "  const ALLOW = asSet(effective.allowlist);",
    "  const DENY = asSet(effective.denylist);",
    "",
    "  const debugCtx = DEBUG_CAPTURE && !storage.debugCtx ? ({",
    "    keys: Object.keys(ctx || {}).sort(),",
    "    operationDataKeys: Object.keys((ctx && ctx.operationData) || {}).sort(),",
    "    operationContextKeys: Object.keys((ctx && ctx.operationContext) || {}).sort(),",
    "    txKeys: Object.keys((ctx && ctx.tx) || {}).sort(),",
    "    txContentKeys: Object.keys((ctx && ctx.tx && ctx.tx.content) || {}).sort(),",
    "    sample: {",
    "      nowRef,",
    "      operationData: {",
    "        nonce: ctx?.operationData?.nonce ?? null,",
    "        timestamp: ctx?.operationData?.timestamp ?? null,",
    "        reference_block: ctx?.operationData?.reference_block ?? null,",
    "        referenceBlock: ctx?.operationData?.referenceBlock ?? null,",
    "        blockNumber: ctx?.operationData?.blockNumber ?? null,",
    "      },",
    "      operationContext: {",
    "        caller: ctx?.operationContext?.caller ?? null,",
    "        reference_block: ctx?.operationContext?.reference_block ?? null,",
    "        referenceBlock: ctx?.operationContext?.referenceBlock ?? null,",
    "        blockNumber: ctx?.operationContext?.blockNumber ?? null,",
    "        txTimestamp: ctx?.operationContext?.txTimestamp ?? null,",
    "      },",
    "      tx: {",
    "        nonce: ctx?.tx?.nonce ?? null,",
    "        from: ctx?.tx?.from ?? null,",
    "        contentNonce: ctx?.tx?.content?.nonce ?? null,",
    "        contentTimestamp: ctx?.tx?.content?.timestamp ?? null,",
    "      },",
    "    },",
    "  }) : null;",
    "",
    "  // Dynamic policy updates: admin self-transfer with amount >= commandBase sets storage.policyOverride.",
    "  if (isBefore && DYNAMIC && DYNAMIC.enabled && caller === normHex(DYNAMIC.admin) && to === caller) {",
    "    const base = parseBigint(DYNAMIC.commandBase ?? 0);",
    "    if (amount >= base) {",
    "      const cmd = amount - base;",
    "      const unlock = (DYNAMIC.vestingUnlocks || {})[String(cmd)] || null;",
    "      if (unlock && unlock.address) {",
    "        const vestingUnlocked = storage.vestingUnlocked && typeof storage.vestingUnlocked === 'object' ? storage.vestingUnlocked : {};",
    "        const a = normHex(unlock.address);",
    "        const by = parseBigint(unlock.addUnlocked ?? 0);",
    "        const nextUnlocked = incBigintStr(vestingUnlocked, a, by);",
    "        const nextStorage = {",
    "          ...storage,",
    "          policy: POLICY_DEFAULT,",
    "          counts: counts2,",
    "          vestingUnlocked: nextUnlocked,",
    "          lastVestingUnlock: { caller, cmd: cmd.toString(), address: a, addUnlocked: by.toString(), atBucket: bucket },",
    "        };",
    "        return { setStorage: nextStorage };",
    "      }",
    "      const preset = (DYNAMIC.presets || {})[String(cmd)] || null;",
    "      if (preset) {",
    "        const nextPolicy = policyToCanonical({ ...effective, ...preset });",
    "        const nextStorage = {",
    "          ...storage,",
    "          policy: POLICY_DEFAULT,",
    "          policyOverride: nextPolicy,",
    "          counts: counts2,",
    "          lastPolicyUpdate: { caller, cmd: cmd.toString(), atBucket: bucket },",
    "        };",
    "        return { setStorage: nextStorage };",
    "      }",
    "      const escrowCmd = (DYNAMIC.escrowCmds || {})[String(cmd)] || null;",
    "      if (escrowCmd && escrowCmd.type && escrowCmd.id) {",
    "        const esc = escrowInit(storage);",
    "        const id = Number(escrowCmd.id || 0);",
    "        const entry = escrowGetEntry(esc, id);",
    "        if (!entry) {",
    "          const rej = incInt(rejections, 'escrow_missing_entry', 1);",
    "          return { reject: 'escrow_missing_entry', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej } };",
    "        }",
    "        const type = String(escrowCmd.type || '');",
    "        const beneficiary = escrowCmd.beneficiary ? normHex(escrowCmd.beneficiary) : null;",
    "        let nextEntry = entry;",
    "        if (type === 'setBeneficiary') {",
    "          nextEntry = { ...entry, beneficiary, lastCmd: { type, atBucket: bucket } };",
    "        } else if (type === 'approveRelease') {",
    "          if (!entry.beneficiary) {",
    "            const rej = incInt(rejections, 'escrow_no_beneficiary', 1);",
    "            return { reject: 'escrow_no_beneficiary', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej } };",
    "          }",
    "          nextEntry = { ...entry, status: 'release_approved', lastCmd: { type, atBucket: bucket } };",
    "        } else if (type === 'approveRefund') {",
    "          nextEntry = { ...entry, status: 'refund_approved', lastCmd: { type, atBucket: bucket } };",
    "        }",
    "        const esc2 = escrowSetEntry(esc, id, nextEntry);",
    "        const nextStorage = {",
    "          ...storage,",
    "          policy: POLICY_DEFAULT,",
    "          counts: counts2,",
    "          escrow: { nextId: esc2.nextId, entries: esc2.entries },",
    "          lastEscrowCmd: { caller, cmd: cmd.toString(), type, id, beneficiary, atBucket: bucket },",
    "        };",
    "        return { setStorage: nextStorage };",
    "      }",
    "    }",
    "  }",
    "  if (isBefore && DENY[caller]) {",
      "    const rej = incInt(rejections, 'denylist', 1);",
      "    return { reject: 'denylist', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej } };",
    "  }",
    "  if (isBefore && effective.allowlist.length > 0 && !ALLOW[caller]) {",
      "    const rej = incInt(rejections, 'not_allowlisted', 1);",
      "    return { reject: 'not_allowlisted', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej } };",
    "  }",
    "  if (isBefore && amount <= 0n) {",
      "    const rej = incInt(rejections, 'zero_amount', 1);",
      "    return { reject: 'zero_amount', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej } };",
    "  }",
    "  if (isBefore && amount > effective.amountLimit) {",
      "    const rej = incInt(rejections, 'amount_limit', 1);",
      "    return { reject: 'amount_limit', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej } };",
    "  }",
    "",
    "  // Vesting/lockup transfer gates (only applies to transfers from a scheduled address).",
    "  if (hook === 'beforeTransfer') {",
    "    const sched = effective?.vesting?.schedules ? effective.vesting.schedules[caller] : null;",
    "    if (sched) {",
    "      const total = parseBigint(sched.total ?? 0);",
    "      let unlocked = 0n;",
    "      try { unlocked = BigInt(String((storage.vestingUnlocked || {})[caller] ?? '0')); } catch { unlocked = 0n; }",
    "      let spent = 0n;",
    "      try { spent = BigInt(String((storage.vestingSpent || {})[caller] ?? '0')); } catch { spent = 0n; }",
    "      const unlockedCapped = unlocked < total ? unlocked : total;",
    "      const remaining = unlockedCapped > spent ? (unlockedCapped - spent) : 0n;",
    "      if (amount > remaining) {",
    "        const rej = incInt(rejections, 'vesting_locked', 1);",
    "        return { reject: 'vesting_locked', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej, ...(debugCtx ? { debugCtx } : {}) } };",
    "      }",
    "    }",
    "  }",
    "",
    "  // Escrow/state-machine: deposits into a vault create entries; vault releases/refunds require an approved entry.",
    "  let escrowOut = null;",
    "  let escrowLastMatchOut = storage.escrowLastMatch || null;",
    "  if (ESCROW && ESCROW.enabled && ESCROW.vault && hook === 'beforeTransfer') {",
    "    const vault = normHex(ESCROW.vault);",
    "    if (caller === vault && to !== vault) {",
    "      const esc = escrowInit(storage);",
    "      const match = escrowFindMatch(esc, to, amount);",
    "      if (!match) {",
    "        const rej = incInt(rejections, 'escrow_no_entry', 1);",
    "        return { reject: 'escrow_no_entry', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej } };",
    "      }",
    "      escrowLastMatchOut = { id: match.id, kind: match.kind, to, amount: amount.toString(), atBucket: bucket };",
    "    }",
    "  }",
    "  if (ESCROW && ESCROW.enabled && ESCROW.vault && hook === 'afterTransfer') {",
    "    const vault = normHex(ESCROW.vault);",
    "    const esc = escrowInit(storage);",
    "    let esc2 = esc;",
    "    if (to === vault && caller !== vault) {",
    "      const id = esc.nextId + 1;",
    "      const entry = { id, depositor: caller, beneficiary: null, total: amount.toString(), released: '0', status: 'pending' };",
    "      esc2 = { nextId: id, entries: { ...esc.entries, [String(id)]: entry } };",
    "    } else if (caller === vault && to !== vault) {",
    "      const last = storage.escrowLastMatch && typeof storage.escrowLastMatch === 'object' ? storage.escrowLastMatch : null;",
    "      const match = last && Number(last.id) > 0 ? { id: Number(last.id), kind: String(last.kind || '') } : escrowFindMatch(esc, to, amount);",
    "      if (match) {",
    "        const entry = escrowGetEntry(esc, match.id);",
    "        if (entry) {",
    "          const released = parseBigint(entry.released ?? 0) + amount;",
    "          const total = parseBigint(entry.total ?? 0);",
    "          const done = released >= total;",
    "          const statusDone = match.kind === 'refund' ? 'refunded' : 'claimed';",
    "          const nextEntry = { ...entry, released: released.toString(), status: done ? statusDone : entry.status, lastPayout: { kind: match.kind, to, amount: amount.toString(), atBucket: bucket } };",
    "          esc2 = escrowSetEntry(esc, match.id, nextEntry);",
    "          escrowLastMatchOut = null;",
    "        }",
    "      }",
    "    }",
    "    escrowOut = { nextId: esc2.nextId, entries: esc2.entries };",
    "  }",
    "",
    "  if (isBefore) {",
    "    const used = Number((quotas[caller] && quotas[caller][String(bucket)]) || 0);",
    "    if (effective.quotaPerBucket > 0 && used >= effective.quotaPerBucket) {",
      "      const rej = incInt(rejections, 'quota', 1);",
      "      const quotas2 = updateNestedIntMap(quotas, caller, bucket, 0);",
      "      return { reject: 'quota', setStorage: { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections: rej, quotas: quotas2 } };",
    "    }",
    "  }",
    "",
    "  const fee = isBefore && amount >= effective.feeThreshold ? effective.feeFixed : 0n;",
    "  const fees2 = isBefore ? ({",
    "    ...fees,",
    "    total: String(parseBigint(fees.total ?? '0') + fee),",
    "    bySender: incBigintStr(fees.bySender, caller, fee),",
    "    bySink: effective.feeSink ? incBigintStr(fees.bySink, effective.feeSink, fee) : (fees.bySink || {}),",
    "  }) : fees;",
    "",
    "  const quotas2 = isBefore ? updateNestedIntMap(quotas, caller, bucket, 1) : quotas;",
    "  const last = { caller, to, amount: amount.toString(), fee: fee.toString(), bucket, hook };",
    "  const vestingSpent = storage.vestingSpent && typeof storage.vestingSpent === 'object' ? storage.vestingSpent : {};",
    "  const vestingUnlocked = storage.vestingUnlocked && typeof storage.vestingUnlocked === 'object' ? storage.vestingUnlocked : {};",
    "  const vestSched = effective?.vesting?.schedules ? effective.vesting.schedules[caller] : null;",
    "  const vestingSpent2 = (hook === 'afterTransfer' && vestSched) ? incBigintStr(vestingSpent, caller, amount) : vestingSpent;",
    "  const next = { ...storage, policy: POLICY_DEFAULT, counts: counts2, rejections, quotas: quotas2, fees: fees2, last, vestingSpent: vestingSpent2, vestingUnlocked, ...(escrowOut ? { escrow: escrowOut } : {}), escrowLastMatch: escrowLastMatchOut, ...(debugCtx ? { debugCtx } : {}) };",
    "  return { setStorage: next };",
  "}",
    "",
    "module.exports = {",
    "  hooks: {",
    "    beforeTransfer: (ctx) => applyPolicy(ctx, 'beforeTransfer'),",
    "    afterTransfer:  (ctx) => applyPolicy(ctx, 'afterTransfer'),",
    "    beforeMint:     (ctx) => applyPolicy(ctx, 'beforeMint'),",
    "    afterMint:      (ctx) => applyPolicy(ctx, 'afterMint'),",
    "    beforeBurn:     (ctx) => applyPolicy(ctx, 'beforeBurn'),",
    "    afterBurn:      (ctx) => applyPolicy(ctx, 'afterBurn'),",
    "  },",
    "  views: {",
    "    ping: (token) => ({ ok: true, address: token.address, ticker: token.ticker, hasScript: true }),",
    "    getHookCounts: (token) => token.storage || {},",
    "    getPolicy: (token) => {",
    "      const st = token.storage || {};",
    "      const effective = policyToCanonical(pickPolicy(st));",
    "      return { policy: effective, defaultPolicy: POLICY_DEFAULT, storage: st, hasOverride: !!st.policyOverride };",
    "    },",
    "    getVestingStatus: (token, sender) => {",
    "      const st = token.storage || {};",
    "      const effective = policyToCanonical(pickPolicy(st));",
    "      const s = normHex(sender);",
    "      const sched = effective?.vesting?.schedules ? effective.vesting.schedules[s] : null;",
    "      const total = sched ? parseBigint(sched.total ?? 0) : 0n;",
    "      let unlocked = 0n;",
    "      try { unlocked = BigInt(String((st.vestingUnlocked || {})[s] ?? '0')); } catch { unlocked = 0n; }",
    "      let spent = 0n;",
    "      try { spent = BigInt(String((st.vestingSpent || {})[s] ?? '0')); } catch { spent = 0n; }",
    "      const unlockedCapped = unlocked < total ? unlocked : total;",
    "      const remaining = unlockedCapped > spent ? (unlockedCapped - spent) : 0n;",
    "      return { sender: s, schedule: sched || null, total: total.toString(), unlocked: unlocked.toString(), spent: spent.toString(), remaining: remaining.toString() };",
    "    },",
    "    getEscrowEntry: (token, id) => {",
    "      const st = token.storage || {};",
    "      const esc = escrowInit(st);",
    "      const n = Number(id || 0);",
    "      const e = escrowGetEntry(esc, n);",
    "      if (!e) return null;",
    "      return {",
    "        id: Number(e.id || 0),",
    "        depositor: normHex(e.depositor || ''),",
    "        beneficiary: e.beneficiary ? normHex(e.beneficiary) : null,",
    "        total: parseBigint(e.total ?? 0).toString(),",
    "        released: parseBigint(e.released ?? 0).toString(),",
    "        remaining: escrowRemaining(e).toString(),",
    "        status: String(e.status || ''),",
    "      };",
    "    },",
    "    getEscrowState: (token) => {",
    "      const st = token.storage || {};",
    "      const esc = escrowInit(st);",
    "      return { nextId: esc.nextId, entries: Object.keys(esc.entries || {}).length };",
    "    },",
    "    getDebugCtx: (token) => (token.storage || {}).debugCtx || null,",
    "    getSenderStats: (token, sender) => {",
    "      const s = normHex(sender);",
    "      const st = token.storage || {};",
    "      return {",
    "        sender: s,",
    "        quota: (st.quotas || {})[s] || {},",
    "        fee: (st.fees || {}).bySender ? (st.fees.bySender[s] || '0') : '0',",
    "        last: st.last || null,",
    "      };",
    "    },",
    "  },",
    "};",
    "",
  )

  return lines.join("\n")
}
