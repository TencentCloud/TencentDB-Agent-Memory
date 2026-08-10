/**
 * tz-09 S6 — two applies against one store are serialized (Ф7).
 *
 * The scenario is implemented in `f7-serial-apply.mts` (written with the phase it
 * belongs to); this is the S-numbered entry point the package's check table
 * names, so both commands run the same code rather than two drifting copies.
 */
import "./f7-serial-apply.mts";
