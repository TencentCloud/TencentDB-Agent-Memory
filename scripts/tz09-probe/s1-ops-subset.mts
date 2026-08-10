/**
 * tz-09 S1 — a role may not perform an op outside its ops_subset (Ф3).
 *
 * The scenario is implemented in `f3-gate.mts` (written with the phase it
 * belongs to); this is the S-numbered entry point the package's check table
 * names, so both commands run the same code rather than two drifting copies.
 */
import "./f3-gate.mts";
