// callrec-web serves the WebUSB installer page with the phone payload embedded.
// Open the printed URL in desktop Chrome/Edge; the browser then talks ADB to the
// phone over USB, so the local adb server must not be running (adb kill-server).
//
// WebUSB only works in a secure context; http://localhost and http://127.0.0.1 qualify.
package main

import (
	"flag"
	"log"
	"net/http"

	"callrec/web"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:8084", "listen address (keep it on localhost unless you add TLS)")
	flag.Parse()

	files := http.FileServer(http.FS(web.FS))
	http.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store") // always serve the payload just built
		files.ServeHTTP(w, r)
	}))

	log.Printf("callrec-web: open http://%s in Chrome/Edge (run `adb kill-server` first)", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
