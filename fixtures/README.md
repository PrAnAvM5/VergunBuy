# Fixtures

Recorded responses from the public APIs for the 8–10 hand-checked test plots.
One folder per address, named `<postcode>-<number>`, containing the raw responses
and `expected.json` (the hand-checked result).

These drive the engine regression tests: a change that turns any expected red or
amber position green fails CI.
