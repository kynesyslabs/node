import { web2UserIdLookupKey } from "./web2UserId"

/**
 * Which stored web2 links one unlink request removes, under
 * identityCarryover.
 *
 * Awards and the first-connection check key on the platform account
 * (context + userId); the username is a label the client supplied at link
 * time, not unique on an account and free to go stale. An unlink therefore
 * removes exactly one platform account: every stored link with the userId
 * named, or, when the request names only a username (today's SDK), every
 * link with the userId of the single link carrying that username.
 *
 * A link stored without a userId cannot be named by one. A request whose
 * username finds such a link alone removes that link only; the genesis
 * snapshot holds exactly one of them (a Twitter link), see
 * docs/mainnet/genesis-import.md.
 */

type StoredLink = { username?: unknown; userId?: unknown }

export type Web2UnlinkRequest = { username?: unknown; userId?: unknown }

export type Web2UnlinkSelection<T> =
    | { ok: true; indexes: number[]; removed: T }
    | { ok: false; message: string }

function hasUserId(value: unknown): boolean {
    return value !== undefined && value !== null && value !== ""
}

export function selectWeb2Unlink<T extends StoredLink>(
    links: T[],
    request: Web2UnlinkRequest,
    notFound: string,
    eligible: (link: T) => boolean = () => true,
): Web2UnlinkSelection<T> {
    const sameAccount = (userId: unknown) => {
        const key = web2UserIdLookupKey(userId)
        return links
            .map((link, i) =>
                eligible(link) &&
                hasUserId(link.userId) &&
                web2UserIdLookupKey(link.userId) === key
                    ? i
                    : -1,
            )
            .filter(i => i >= 0)
    }

    if (hasUserId(request.userId)) {
        const indexes = sameAccount(request.userId)
        return indexes.length === 0
            ? { ok: false, message: notFound }
            : { ok: true, indexes, removed: links[indexes[0]] }
    }

    if (typeof request.username !== "string" || request.username === "") {
        return { ok: false, message: notFound }
    }
    const named = links
        .map((link, i) =>
            eligible(link) && link.username === request.username ? i : -1,
        )
        .filter(i => i >= 0)
    if (named.length === 0) return { ok: false, message: notFound }
    if (named.length > 1) {
        return {
            ok: false,
            message:
                "Several links carry this username; name the userId of the one to unlink",
        }
    }
    const only = links[named[0]]
    if (!hasUserId(only.userId)) {
        return { ok: true, indexes: named, removed: only }
    }
    const indexes = sameAccount(only.userId)
    return { ok: true, indexes, removed: only }
}
