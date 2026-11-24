# Web

`legacy/` holds the frontend MVP source (engine, UI, build script) as it was presented.
It is kept unchanged for reference and is ported into a Vite + TypeScript app that uses
`@vergunbuy/engine` and the API, plus two new views: the **Inspector** (click any object to
see its facts and derivation) and the **System view** page (the live pipeline trace).
