"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.today = today;
exports.slugify = slugify;
exports.findInitiativeFilename = findInitiativeFilename;
function today() {
    return new Date().toISOString().split('T')[0];
}
function slugify(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function findInitiativeFilename(mdocsRoot, initiatives, id) {
    void mdocsRoot;
    return initiatives.findKeyById(id);
}
//# sourceMappingURL=utils.js.map