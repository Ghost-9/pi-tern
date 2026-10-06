export * from "./native.d.mts";

import type { FrameOp, FrameNode } from "./native.d.mts";

export declare function nodeOf(op: FrameOp): FrameNode | undefined;
