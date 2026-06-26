"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MdocsLifecycleService = void 0;
class MdocsLifecycleService {
    mdocs;
    initiatives;
    options;
    constructor(mdocs, initiatives, options = {}) {
        this.mdocs = mdocs;
        this.initiatives = initiatives;
        this.options = options;
    }
    ensureInitialized() {
        if (this.mdocs.exists()) {
            return { initialized: false, bootstrapInitiativeCreated: false };
        }
        const date = new Date().toISOString().split('T')[0];
        this.mdocs.init();
        if (this.options.createInstallInitiative === false) {
            return { initialized: true, bootstrapInitiativeCreated: false };
        }
        this.initiatives.create({
            id: this.options.installInitiativeId || 'install-mdocs',
            title: this.options.installInitiativeTitle || 'Install and Configure mdocs',
            status: 'active',
            created: date,
            updated: date,
            owner: this.options.owner || 'system',
            tags: this.options.tags || ['setup', 'plugin'],
            relatedWiki: [],
            objective: 'Install and configure mdocs for this project',
            plan: [
                { description: 'Install package', status: 'pending' },
                { description: 'Configure harness adapter', status: 'pending' },
                { description: 'Verify workflow', status: 'pending' }
            ],
            progressLog: ['Mdocs initialized'],
            artifacts: []
        });
        return { initialized: true, bootstrapInitiativeCreated: true };
    }
}
exports.MdocsLifecycleService = MdocsLifecycleService;
//# sourceMappingURL=lifecycle.js.map