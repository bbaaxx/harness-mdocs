import { InitiativeManager } from './managers/initiative';
import { MdocsManager } from './managers/mdocs';

export interface MdocsLifecycleOptions {
  createInstallInitiative?: boolean;
  installInitiativeTitle?: string;
  installInitiativeId?: string;
  owner?: string;
  tags?: string[];
}

export interface MdocsLifecycleResult {
  initialized: boolean;
  bootstrapInitiativeCreated: boolean;
}

export class MdocsLifecycleService {
  constructor(
    private readonly mdocs: MdocsManager,
    private readonly initiatives: InitiativeManager,
    private readonly options: MdocsLifecycleOptions = {}
  ) {}

  ensureInitialized(): MdocsLifecycleResult {
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
