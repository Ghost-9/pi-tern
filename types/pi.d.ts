// Minimal ambient stubs so `tsc --noEmit` can run in CI without installing pi.
// Real types come from the pi installation at development time; these only keep the
// external module shapes resolvable.

declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		on(event: string, handler: (...args: any[]) => unknown): void;
		registerTool(tool: unknown): void;
		registerCommand(
			name: string,
			options: { description: string; handler: (args: string, ctx: any) => unknown },
		): void;
	}
	export function defineTool<T extends object>(tool: T): T;
}
