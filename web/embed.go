// Package web holds the browser app and the phone payload, embedded into the server binary.
package web

import "embed"

// FS is the site root: index.html, app.bundle.js and payload/ (dex + daemon binaries).
//
//go:embed index.html app.bundle.js payload
var FS embed.FS
