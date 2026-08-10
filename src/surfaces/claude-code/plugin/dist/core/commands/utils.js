"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.today = today;
exports.slugify = slugify;
exports.findInitiativeFilename = findInitiativeFilename;
exports.normalizeCommandKeys = normalizeCommandKeys;
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
/**
 * Known snake_case → camelCase key aliases accepted on command inputs.
 * Consumer schemas author snake_case frontmatter; the command surface is
 * camelCase. Normalizing at the boundary means both spellings work.
 */
const KEY_ALIASES = {
    related_initiatives: 'relatedInitiatives',
    source_initiatives: 'sourceInitiatives',
    sources: 'sourceInitiatives',
    knowledge_type: 'knowledgeType',
    related_wiki: 'relatedWiki',
    due_date: 'dueDate',
    depends_on: 'dependsOn',
    handoff_summary: 'handoffSummary',
    open_questions: 'openQuestions',
    next_action: 'nextAction',
    expected_duration: 'expectedDuration',
    initiative_id: 'initiativeId',
    wiki_slug: 'wikiSlug'
};
/**
 * Return a copy of `args` with known snake_case keys mapped to their
 * camelCase equivalent. A camelCase key already present wins over its
 * snake_case alias; the snake_case spelling is always removed.
 */
function normalizeCommandKeys(args) {
    const out = { ...args };
    for (const [snake, camel] of Object.entries(KEY_ALIASES)) {
        if (out[snake] !== undefined && out[camel] === undefined) {
            out[camel] = out[snake];
        }
        delete out[snake];
    }
    return out;
}
//# sourceMappingURL=utils.js.map