# Third-party notices

Omnium's own code is MIT-licensed (see `LICENSE`). It ships zero runtime
dependencies; the shipped plugins vendor small, hand-ported modules and adapt
third-party prompt material instead. Where shipped material derives from
third-party code, its license is reproduced here in full, as the license terms
require for source redistribution. So the notice travels with the installed
artifact (not only this repo root), each affected plugin also carries its own
copy:

- `plugins/expertum/THIRD-PARTY.md` — wshobson/agents (MIT), below.

## wshobson/agents (MIT)

Some of the expert lenses under `plugins/expertum/experts/*.md` and the shared
analyst skeleton in `plugins/expertum/agents/analyst.md` are
adapted from the wshobson/agents project (https://github.com/wshobson/agents). The full
license text and copyright notice of that project follow.

```
MIT License

Copyright (c) 2024 Seth Hobson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
