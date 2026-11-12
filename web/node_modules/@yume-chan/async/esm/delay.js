export function delay(time) {
    return new Promise(resolve => {
        // Don't call `resolve` with any value.
        globalThis.setTimeout(() => resolve(), time);
    });
}
//# sourceMappingURL=delay.js.map