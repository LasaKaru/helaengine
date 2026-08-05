#!/bin/sh
cd "$(dirname "$0")" && (command -v xdg-open >/dev/null && xdg-open http://localhost:5174 &) ; node serve.js
