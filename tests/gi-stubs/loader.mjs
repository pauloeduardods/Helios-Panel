// Node module hooks: maps gi://GLib and gi://Gio to tiny fakes so the
// GLib-based sysfs/nvidia code can be exercised against a fake /sys tree.
export async function resolve(specifier, context, next) {
    if (specifier === 'gi://GLib' || specifier === 'gi://Gio')
        return {url: new URL(`./${specifier.slice(5)}.mjs`, import.meta.url).href, shortCircuit: true};
    return next(specifier, context);
}
