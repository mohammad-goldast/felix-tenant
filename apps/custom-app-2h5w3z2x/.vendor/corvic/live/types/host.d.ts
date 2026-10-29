/**
 * The channel from an app document to the page embedding it.
 *
 * An app renders in an iframe on a ledger origin; everything it tells the
 * embedding page goes through `postMessage`. This module owns delivery and the
 * target origin. Message shapes belong to their senders.
 *
 * Vocabulary: `corvic:ready`, `corvic:navigate`, and `corvic:error` from the
 * mount; `corvic:selection` and `corvic:cancelled` from the inspector;
 * `corvic:inspect` is the only message that travels parent → iframe.
 */
/** Anything addressed to the host. The prefix is what marks it as ours. */
export interface HostMessage {
    readonly type: `corvic:${string}`;
}
/**
 * Remember where the host is, so later messages go there.
 *
 * Learned from a message the host sent: the parent is cross-origin, so its
 * location is unreadable. An opaque origin (`"null"`) matches every sandboxed
 * frame; targeting it is equivalent to broadcasting.
 */
export declare function rememberHostOrigin(origin: string): void;
/**
 * Send one message to the embedding page, if there is one.
 *
 * Targeted once anything has arrived from the host. Until then it broadcasts:
 * `ready` is what tells the host an app exists, so it cannot wait for the host
 * to speak first. Nothing sent before then is a secret — the host learns which
 * page is showing and whether it failed, both of which it can see.
 */
export declare function postToHost<M extends HostMessage>(message: M): void;
