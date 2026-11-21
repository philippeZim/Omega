// First import of main.ts: modules read their state from localStorage while they load.
import { windowLabel } from "./windowEvents";
import { installWindowStorage } from "./windowStorage";

installWindowStorage(windowLabel());
