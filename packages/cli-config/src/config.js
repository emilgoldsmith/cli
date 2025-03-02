import command from '@percy/cli-command';

import create from './create';
import validate from './validate';
import migrate from './migrate';

export const config = command('config', {
  description: 'Manage Percy config files',
  commands: [create, validate, migrate]
});

export default config;
