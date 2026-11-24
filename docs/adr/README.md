# Architecture decision records

ADR 001–014 (stack, hosting, data sources, API shape) and 015–025 (how the system behaves) are
recorded in the design document "VergunBuy Backend – System Design v1", sections 4 and 4b.
New decisions are added here as one file each, using `template.md`.

| ADR | Decision (short)                                                               |
| --- | ------------------------------------------------------------------------------ |
| 015 | Back yard / front yard derived from the legal achtererfgebied definition       |
| 016 | Every plot edge classified: public, water, rear path, shared wall, neighbour   |
| 017 | Narrow rear paths are non-public (flagged); water is flagged, never guessed    |
| 018 | Tri-state checks; green only on known data                                     |
| 019 | Certainty label on every fact                                                  |
| 020 | Question budget: ask only what data cannot answer, with "don't know"           |
| 021 | Carport rules follow the official Vergunningcheck question tree                |
| 022 | Civil law is an advisory layer, never decides the verdict                      |
| 023 | Inspector: every object clickable with facts, certainty, source and trace      |
| 024 | System view page: live pipeline with failing steps highlighted                 |
| 025 | API protection: server-side keys, CORS, validation, rate limit, host allowlist |
