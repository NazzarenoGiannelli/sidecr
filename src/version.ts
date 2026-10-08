/**
 * The version of what the server and the window say to each other. Bump it whenever a change needs the running
 * server restarted: `open` replaces a server that reports another version (or none), so an upgrade takes effect
 * on the next press of the open key instead of after the idle shutdown.
 * 5: the rename to Sidecr (app marker "sidecr", state directory follows the new plugin id).
 */
export const SERVER_API_VERSION = 5;
