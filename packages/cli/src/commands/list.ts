import chalk from 'chalk';
import ms from 'ms';
import table from 'text-table';
import fs from 'fs-extra';
import { basename, resolve } from 'path';
import Now from '../util';
import getArgs from '../util/get-args';
import { handleError } from '../util/error';
import logo from '../util/output/logo';
import elapsed from '../util/output/elapsed';
import strlen from '../util/strlen';
// import getScope from '../util/get-scope';
import toHost from '../util/to-host';
import parseMeta from '../util/parse-meta';
import { isValidName } from '../util/is-valid-name';
import getCommandFlags from '../util/get-command-flags';
import { getPkgName, getCommandName } from '../util/pkg-name';
import Client from '../util/client';
import { Deployment } from '../types';
import getUser from '../util/get-user';
import validatePaths from '../util/validate-paths';
import { getLinkedProject } from '../util/projects/link';

const help = () => {
  console.log(`
  ${chalk.bold(`${logo} ${getPkgName()} list`)} [app]

  ${chalk.dim('Options:')}

    -h, --help                     Output usage information
    -A ${chalk.bold.underline('FILE')}, --local-config=${chalk.bold.underline(
    'FILE'
  )}   Path to the local ${'`vercel.json`'} file
    -Q ${chalk.bold.underline('DIR')}, --global-config=${chalk.bold.underline(
    'DIR'
  )}    Path to the global ${'`.vercel`'} directory
    -d, --debug                    Debug mode [off]
    -t ${chalk.bold.underline('TOKEN')}, --token=${chalk.bold.underline(
    'TOKEN'
  )}        Login token
    -S, --scope                    Set a custom scope
    -m, --meta                     Filter deployments by metadata (e.g.: ${chalk.dim(
      '`-m KEY=value`'
    )}). Can appear many times.
    -N, --next                     Show next page of results

  ${chalk.dim('Examples:')}

  ${chalk.gray('–')} List all deployments

    ${chalk.cyan(`$ ${getPkgName()} ls`)}

  ${chalk.gray('–')} List all deployments for the app ${chalk.dim('`my-app`')}

    ${chalk.cyan(`$ ${getPkgName()} ls my-app`)}

  ${chalk.gray('–')} Filter deployments by metadata

    ${chalk.cyan(`$ ${getPkgName()} ls -m key1=value1 -m key2=value2`)}

  ${chalk.gray('–')} Paginate deployments for a project, where ${chalk.dim(
    '`1584722256178`'
  )} is the time in milliseconds since the UNIX epoch.

    ${chalk.cyan(`$ ${getPkgName()} ls my-app --next 1584722256178`)}
`);
};

export default async function main(client: Client) {
  let argv;

  try {
    argv = getArgs(client.argv.slice(2), {
      '--all': Boolean,
      '-a': '--all',
      '--meta': [String],
      '-m': '--meta',
      '--next': Number,
      '-N': '--next',
    });
  } catch (err) {
    handleError(err);
    return 1;
  }

  const user = await getUser(client);

  const { output, config } = client;

  const { print, log, error, note, debug, spinner } = output;

  if (argv._.length > 2) {
    error(`${getCommandName('ls [app]')} accepts at most one argument`);
    return 1;
  }

  if (argv['--help']) {
    help();
    return 2;
  }

  const all = argv['--all'];

  if (argv._[0] === 'list' || argv._[0] === 'ls') {
    argv._.shift();
  }

  let paths;
  if (argv._.length > 0) {
    // If path is relative: resolve
    // if path is absolute: clear up strange `/` etc
    paths = argv._.map(item => resolve(process.cwd(), item));
  } else {
    paths = [process.cwd()];
  }

  for (const path of paths) {
    try {
      await fs.stat(path);
    } catch (err) {
      output.error(
        `The specified file or directory "${basename(path)}" does not exist.`
      );
      return 1;
    }
  }

  // check paths
  const pathValidation = await validatePaths(output, paths);

  if (!pathValidation.valid) {
    return pathValidation.exitCode;
  }

  const { path } = pathValidation;

  // retrieve `project` and `org` from .vercel
  const link = await getLinkedProject(client, path);

  if (link.status === 'error') {
    return link.exitCode;
  }

  let { org, project, status } = link;

  let app: string | undefined = argv._[1] || project?.name;
  let host: string | undefined = undefined;

  // let newProjectName = null;
  // let rootDirectory = project ? project.rootDirectory : null;
  // let sourceFilesOutsideRootDirectory: boolean | undefined = true;

  if (status === 'not_linked' && !app) {
    output.print(
      `Looks like this directory isn't linked to a Vercel deployment. Please run ${getCommandName(
        'link'
      )} to link it.`
    );
    return 0;
  }

  // At this point `org` should be populated
  if (!org) {
    throw new Error(`"org" is not defined`);
  }

  const meta = parseMeta(argv['--meta']);

  let contextName = null;

  // try {
  //   ({ contextName } = await getScope(client));
  // } catch (err) {
  //   if (err.code === 'NOT_AUTHORIZED' || err.code === 'TEAM_DELETED') {
  //     error(err.message);
  //     return 1;
  //   }

  //   throw err;
  // }
  contextName = org.slug;
  client.config.currentTeam = org.type === 'team' ? org.id : undefined;

  const { currentTeam } = config;

  const nextTimestamp = argv['--next'];

  if (typeof nextTimestamp !== undefined && Number.isNaN(nextTimestamp)) {
    error('Please provide a number for flag `--next`');
    return 1;
  }

  spinner(`Fetching deployments in ${chalk.bold(contextName)}`);

  const now = new Now({
    client,
    currentTeam,
  });
  const start = Date.now();

  if (app && !isValidName(app)) {
    error(`The provided argument "${app}" is not a valid project name`);
    return 1;
  }

  // Some people are using entire domains as app names, so
  // we need to account for this here
  const asHost = app ? toHost(app) : '';
  if (asHost.endsWith('.now.sh') || asHost.endsWith('.vercel.app')) {
    note(
      `We suggest using ${getCommandName(
        'inspect <deployment>'
      )} for retrieving details about a single deployment`
    );

    const hostParts: string[] = asHost.split('-');

    if (hostParts.length < 2) {
      error('Only deployment hostnames are allowed, no aliases');
      return 1;
    }

    app = undefined;
    host = asHost;
  }

  debug('Fetching deployments');
  const response = await now.list(all ? undefined : app, {
    version: 6,
    meta,
    nextTimestamp,
  });

  let {
    deployments,
    pagination,
  }: {
    deployments: Deployment[];
    pagination: { count: number; next: number };
  } = response;

  if (app && !all && !deployments.length) {
    debug(
      'No deployments: attempting to find deployment that matches supplied app name'
    );
    let match;

    try {
      await now.findDeployment(app);
    } catch (err) {
      if (err.status === 404) {
        debug('Ignore findDeployment 404');
      } else {
        throw err;
      }
    }

    if (match !== null && typeof match !== 'undefined') {
      debug('Found deployment that matches app name');
      deployments = Array.of(match);
    }
  }

  now.close();

  if (host) {
    deployments = deployments.filter(deployment => deployment.url === host);
  }

  log(
    `Deployments${
      app && !all ? ` for ${chalk.bold(chalk.magenta(app))}` : ''
    } under ${chalk.bold(chalk.magenta(contextName))} ${elapsed(
      Date.now() - start
    )}`
  );

  // we don't output the table headers if we have no deployments
  if (!deployments.length) {
    log(`No deployments found.`);
    return 0;
  }

  // information to help the user find other deployments or instances
  if (app == null) {
    log(
      `To list more deployments for a project run ${getCommandName(
        'ls [project]'
      )}`
    );
  }

  print('\n');

  let tablePrint;
  if (app && !all) {
    const isUserScope = user.username === contextName;
    tablePrint = `${table(
      [
        (isUserScope
          ? ['deployment url', 'state', 'age', 'duration']
          : ['deployment url', 'state', 'age', 'duration', 'username']
        ).map(header => chalk.bold(chalk.cyan(header))),
        ...deployments
          .sort(sortRecent())
          .map((dep, i) => [
            [
              chalk.bold(
                (i === 0 ? chalk.gray('> ') : '') + 'https://' + dep.url
              ),
              stateString(dep.state),
              chalk.gray(ms(Date.now() - dep.createdAt)),
              chalk.gray(getDeploymentDuration(dep)),
              isUserScope ? '' : chalk.dim(dep.creator.username),
            ],
          ])
          // flatten since the previous step returns a nested
          // array of the deployment and (optionally) its instances
          .flat()
          .filter(app =>
            // if an app wasn't supplied to filter by,
            // we only want to render one deployment per app
            app === null ? filterUniqueApps() : () => true
          ),
      ],
      {
        align: isUserScope ? ['l', 'l', 'l', 'l'] : ['l', 'l', 'l', 'l', 'l'],
        hsep: ' '.repeat(isUserScope ? 4 : 5),
        stringLength: strlen,
      }
    ).replace(/^/gm, '  ')}\n`;
  } else {
    tablePrint = `${table(
      [
        ['project', 'latest deployment', 'state', 'age'].map(header =>
          chalk.bold(chalk.cyan(header))
        ),
        ...deployments
          .sort(sortRecent())
          .map(dep => [
            [
              getProjectName(dep),
              chalk.bold('https://' + dep.url),
              stateString(dep.state),
              chalk.gray(ms(Date.now() - dep.createdAt)),
            ],
          ])
          // flatten since the previous step returns a nested
          // array of the deployment and (optionally) its instances
          .flat()
          .filter(app =>
            // if an app wasn't supplied to filter by,
            // we only want to render one deployment per app
            app === null ? filterUniqueApps() : () => true
          ),
      ],
      {
        align: ['l', 'l', 'l', 'l'],
        hsep: ' '.repeat(4),
        stringLength: strlen,
      }
    ).replace(/^/gm, '  ')}\n`;
  }

  // print table with deployment information
  console.log(tablePrint);

  if (pagination && pagination.count === 20) {
    const flags = getCommandFlags(argv, ['_', '--next']);
    log(
      `To display the next page run ${getCommandName(
        `ls${app ? ' ' + app : ''}${flags} --next ${pagination.next}`
      )}`
    );
  }
}

function getProjectName(d: Deployment) {
  // We group both file and files into a single project
  if (d.name === 'file') {
    return 'files';
  }

  return d.name;
}

// renders the state string
function stateString(s: string) {
  const CIRCLE = '● ';
  switch (s) {
    case 'INITIALIZING':
    case 'BUILDING':
      return chalk.yellow(CIRCLE) + s;

    case 'ERROR':
      return chalk.red(CIRCLE) + s;

    case 'READY':
      return chalk.green(CIRCLE) + s;

    case 'QUEUED':
      return chalk.white(CIRCLE) + s;

    case 'CANCELED':
      return chalk.gray(s);

    default:
      return chalk.gray('UNKNOWN');
  }
}

function getDeploymentDuration(dep: Deployment): string {
  if (!dep || !dep.ready || !dep.buildingAt) {
    return '?';
  }
  const duration = ms(dep.ready - dep.buildingAt);
  if (duration === '0ms') {
    return '--';
  }
  return duration;
}

// sorts by most recent deployment
function sortRecent() {
  return function recencySort(a: Deployment, b: Deployment) {
    return b.createdAt - a.createdAt;
  };
}

// filters only one deployment per app, so that
// the user doesn't see so many deployments at once.
// this mode can be bypassed by supplying an app name
function filterUniqueApps() {
  const uniqueApps = new Set();
  return function uniqueAppFilter([appName]: [appName: string]) {
    if (uniqueApps.has(appName)) {
      return false;
    }
    uniqueApps.add(appName);
    return true;
  };
}
