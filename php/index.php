<?php
// PHP version of cmd/callrec-web: serves the WebUSB installer page and the phone payload.
// It answers like the Go server (http.FileServer over the embedded web.FS, plus
// Cache-Control: no-store): same routes, redirects, headers, byte ranges and errors.
//
// Only this web server is PHP. The page is JavaScript and the payload (callrecd, callrec.dex)
// runs on the phone, where there is no PHP; both are the very files the Go build embeds.
//
// Local:  php -S 127.0.0.1:8084 php/index.php     (WebUSB needs localhost or HTTPS)
// Host:   php/build.sh, then upload what is in php/dist/ to a folder of an HTTPS site.
// Needs PHP 7.2 or newer.

ini_set('default_mimetype', ''); // like Go: no Content-Type unless one is set below

// Site root: next to this file once built (php/dist), ../web in the source tree.
$root = is_file(__DIR__ . '/index.html') ? __DIR__ : __DIR__ . '/../web';

// The tree web/embed.go embeds: index.html, app.bundle.js and payload/*. A request is
// looked up in this list and never turned into a path, so nothing else can be read.
$files = [
    '/index.html'    => 'text/html; charset=utf-8',
    '/app.bundle.js' => 'text/javascript; charset=utf-8',
];
$payload = [];
foreach (scandir($root . '/payload') ?: [] as $f) {
    if ($f[0] !== '.' && $f[0] !== '_' && is_file("$root/payload/$f")) { // go:embed skips these names too
        $files['/payload/' . $f] = 'application/octet-stream';
        $payload[] = $f;
    }
}

// $path is the request path below the folder this script is mounted at. The built-in
// server always mounts it at the root; a host may put it in a subfolder.
$base = PHP_SAPI === 'cli-server' ? '' : rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'])), '/');
$path = rawurldecode((string) strtok($_SERVER['REQUEST_URI'], '?'));
$path = strncmp($path, $base . '/', strlen($base) + 1) === 0 ? substr($path, strlen($base)) : '';
$head = $_SERVER['REQUEST_METHOD'] === 'HEAD';

header('Cache-Control: no-store'); // always serve the payload just built

function send($status, $type, $body, $head)
{
    http_response_code($status);
    header('Content-Type: ' . $type);
    header('Content-Length: ' . strlen($body));
    if (!$head) {
        echo $body;
    }
    exit;
}

// fail answers like Go's http.Error.
function fail($status, $text, $head)
{
    header('X-Content-Type-Options: nosniff');
    send($status, 'text/plain; charset=utf-8', $text . "\n", $head);
}

function redirect($to, $head)
{
    header('Location: ' . $to, true, 301);
    if (!$head) { // Go sends no length with a HEAD answer it wrote no body for
        header('Content-Length: 0');
    }
    exit;
}

// parseRange is Go's net/http parseRange, reduced to what this server answers with:
// [start, length] for one range, null to send the whole file, [] when the range starts
// past the end, false when it is malformed. Several ranges get the whole file, as the
// Go build answers them.
function parseRange($s, $size)
{
    if (strncmp($s, 'bytes=', 6) !== 0) {
        return false;
    }
    $ranges = [];
    $noOverlap = false;
    foreach (explode(',', substr($s, 6)) as $ra) {
        $ra = trim($ra);
        if ($ra === '') {
            continue;
        }
        $dash = strpos($ra, '-');
        if ($dash === false) {
            return false;
        }
        $from = trim(substr($ra, 0, $dash));
        $to = trim(substr($ra, $dash + 1));
        if ($from === '') { // "-N": the last N bytes
            if (!preg_match('/^[0-9]+$/', $to)) {
                return false;
            }
            $n = min((int) $to, $size);
            $ranges[] = [$size - $n, $n];
            continue;
        }
        if (!preg_match('/^[0-9]+$/', $from)) {
            return false;
        }
        $start = (int) $from;
        if ($start >= $size) {
            $noOverlap = true;
            continue;
        }
        if ($to === '') {
            $ranges[] = [$start, $size - $start];
            continue;
        }
        if (!preg_match('/^[0-9]+$/', $to) || $start > (int) $to) {
            return false;
        }
        $ranges[] = [$start, min((int) $to, $size - 1) - $start + 1];
    }
    if ($noOverlap && !$ranges) {
        return [];
    }
    return count($ranges) === 1 ? $ranges[0] : null;
}

// FileServer redirects index.html to its folder and a folder to its trailing slash.
if ($path === '/index.html') {
    redirect('./', $head);
}
if ($path === '/payload') {
    redirect('payload/', $head);
}
if ($path === '/' || $path === '/index.php') { // index.php: this script asked for by name
    $path = '/index.html';
}
if ($path === '/payload/') { // a folder without index.html gets FileServer's listing
    $list = "<!doctype html>\n<meta name=\"viewport\" content=\"width=device-width\">\n<pre>\n";
    foreach ($payload as $f) {
        $list .= '<a href="' . rawurlencode($f) . '">' . htmlspecialchars($f, ENT_QUOTES) . "</a>\n";
    }
    send(200, 'text/html; charset=utf-8', $list . "</pre>\n", $head);
}
if (!isset($files[$path])) {
    fail(404, '404 page not found', $head);
}

$file = $root . $path; // $path is a key of $files here
$size = filesize($file);
$start = 0;
$length = $size;
$range = isset($_SERVER['HTTP_RANGE']) ? parseRange($_SERVER['HTTP_RANGE'], $size) : null;
if ($range === false) {
    fail(416, 'invalid range', $head);
}
if ($range === []) {
    header("Content-Range: bytes */$size");
    fail(416, 'invalid range: failed to overlap', $head);
}
if ($range !== null) {
    list($start, $length) = $range;
    http_response_code(206);
    header("Content-Range: bytes $start-" . ($start + $length - 1) . "/$size");
}
header('Content-Type: ' . $files[$path]);
header('Accept-Ranges: bytes');
header('Content-Length: ' . $length);
if (!$head) {
    stream_copy_to_stream(fopen($file, 'rb'), fopen('php://output', 'wb'), $length, $start);
}
