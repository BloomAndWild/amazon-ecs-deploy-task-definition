const path = require('path');
const core = require('@actions/core');
const aws = require('aws-sdk');
const yaml = require('yaml');
const fs = require('fs');
const crypto = require('crypto');

const MAX_WAIT_MINUTES = 360;  // 6 hours
const WAIT_DEFAULT_DELAY_SEC = 15;

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'deregisteredAt',
  'registeredBy'
];

// Run task outside of a service
async function runTask(ecs, clusterName, taskDefArn, waitForMinutes) {
  const waitForTask = core.getInput('wait-for-task-stopped', { required: false }) || 'false';
  const startedBy = core.getInput('run-task-started-by', { required: false }) || 'GitHub-Actions';
  const launchType = core.getInput('run-task-launch-type', { required: false }) || 'FARGATE';
  const subnetIds = core.getInput('run-task-subnets', { required: false }) || '';
  const securityGroupIds = core.getInput('run-task-security-groups', { required: false }) || '';
  const containerOverrides = JSON.parse(core.getInput('run-task-container-overrides', { required: false }) || '[]');
  core.info(`Running task with settings: ${JSON.stringify(containerOverrides[0])}`)
  let awsvpcConfiguration = {}

  if (subnetIds != "") {
    awsvpcConfiguration["subnets"] = subnetIds.split(',')
  }

  if (securityGroupIds != "") {
    awsvpcConfiguration["securityGroups"] = securityGroupIds.split(',')
  }

  const runTaskResponse = await ecs.runTask({
    startedBy: startedBy,
    cluster: clusterName,
    taskDefinition: taskDefArn,
    overrides: {
      containerOverrides: containerOverrides
    },
    launchType: launchType,
    networkConfiguration: awsvpcConfiguration === {} ? {} : { awsvpcConfiguration: awsvpcConfiguration }
  }).promise();

  core.debug(`Run task response ${JSON.stringify(runTaskResponse)}`)

  const taskArns = runTaskResponse.tasks.map(task => task.taskArn);
  core.setOutput('run-task-arn', taskArns);
  core.info(`Task running: https://console.aws.amazon.com/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/tasks`);
  core.info(`Task ARN: ${taskArns}`);

  if (runTaskResponse.failures && runTaskResponse.failures.length > 0) {
    const failure = runTaskResponse.failures[0];
    throw new Error(`${failure.arn} is ${failure.reason}`);
  }

  // Wait for task to end
  if (waitForTask && waitForTask.toLowerCase() === "true") {
    await waitForTasksStopped(ecs, clusterName, taskArns, waitForMinutes)
    await tasksExitCode(ecs, clusterName, taskArns)
  } else {
    core.debug('Not waiting for the task to stop');
  }
}

// Poll tasks until they enter a stopped state
async function waitForTasksStopped(ecs, clusterName, taskArns, waitForMinutes) {
  if (waitForMinutes > MAX_WAIT_MINUTES) {
    waitForMinutes = MAX_WAIT_MINUTES;
  }

  core.info(`Waiting for tasks to stop. Will wait for ${waitForMinutes} minutes`);

  const waitTaskResponse = await ecs.waitFor('tasksStopped', {
    cluster: clusterName,
    tasks: taskArns,
    $waiter: {
      delay: WAIT_DEFAULT_DELAY_SEC,
      maxAttempts: (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC
    }
  }).promise();

  core.debug(`Run task response ${JSON.stringify(waitTaskResponse)}`);
  core.info(`SUCCESS - task ${taskArns} completed`);
}

// Check a task's exit code and fail the job on error
async function tasksExitCode(ecs, clusterName, taskArns) {
  const describeResponse = await ecs.describeTasks({
    cluster: clusterName,
    tasks: taskArns
  }).promise();

  const containers = [].concat(...describeResponse.tasks.map(task => task.containers))
  const exitCodes = containers.map(container => container.exitCode)
  const reasons = containers.map(container => container.reason)

  const failuresIdx = [];

  exitCodes.filter((exitCode, index) => {
    if (exitCode !== 0) {
      failuresIdx.push(index)
    }
  })

  const failures = reasons.filter((_, index) => failuresIdx.indexOf(index) !== -1)
  if (failures.length > 0) {
    throw new Error(`Run task failed: ${JSON.stringify(failures)}`);
  }
}

// Deploy to a service that uses the 'ECS' deployment controller
async function updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes, forceNewDeployment) {
  core.debug('Updating the service');
  await ecs.updateService({
    cluster: clusterName,
    service: service,
    taskDefinition: taskDefArn,
    forceNewDeployment: forceNewDeployment
  }).promise();

  const consoleHostname = aws.config.region.startsWith('cn') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';

  core.info(`Deployment started. Watch this deployment's progress in the Amazon ECS console: https://${consoleHostname}/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/services/${service}/events`);

  // Wait for service stability
  if (waitForService && waitForService.toLowerCase() === 'true') {
    core.debug(`Waiting for the service to become stable. Will wait for ${waitForMinutes} minutes`);
    const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;
    await ecs.waitFor('servicesStable', {
      services: [service],
      cluster: clusterName,
      $waiter: {
        delay: WAIT_DEFAULT_DELAY_SEC,
        maxAttempts: maxAttempts
      }
    }).promise();
  } else {
    core.debug('Not waiting for the service to become stable');
  }
}

// Find value in a CodeDeploy AppSpec file with a case-insensitive key
function findAppSpecValue(obj, keyName) {
  return obj[findAppSpecKey(obj, keyName)];
}

function findAppSpecKey(obj, keyName) {
  if (!obj) {
    throw new Error(`AppSpec file must include property '${keyName}'`);
  }

  const keyToMatch = keyName.toLowerCase();

  for (var key in obj) {
    if (key.toLowerCase() == keyToMatch) {
      return key;
    }
  }

  throw new Error(`AppSpec file must include property '${keyName}'`);
}

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    for (var element of value) {
      if (!isEmptyValue(element)) {
        // the array has at least one non-empty element
        return false;
      }
    }
    // the array has no non-empty elements
    return true;
  }

  if (typeof value === 'object') {
    for (var childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return false;
      }
    }
    // the object has no non-empty property
    return true;
  }

  return false;
}

function emptyValueReplacer(_, value) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter(e => !isEmptyValue(e));
  }

  return value;
}

function cleanNullKeys(obj) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
  for (var attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      core.warning(`Ignoring property '${attribute}' in the task definition file. ` +
        'This property is returned by the Amazon ECS DescribeTaskDefinition API and may be shown in the ECS console, ' +
        'but it is not a valid field when registering a new task definition. ' +
        'This field can be safely removed from your task definition file.');
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

function maintainValidObjects(taskDef) {
    if (validateProxyConfigurations(taskDef)) {
        taskDef.proxyConfiguration.properties.forEach((property, index, arr) => {
            if (!('value' in property)) {
                arr[index].value = '';
            }
            if (!('name' in property)) {
                arr[index].name = '';
            }
        });
    }

    if(taskDef && taskDef.containerDefinitions){
      taskDef.containerDefinitions.forEach((container) => {
        if(container.environment){
          container.environment.forEach((property, index, arr) => {
            if (!('value' in property)) {
              arr[index].value = '';
            }
          });
        }
      });
    }
    return taskDef;
}

function validateProxyConfigurations(taskDef){
  return 'proxyConfiguration' in taskDef && taskDef.proxyConfiguration.type && taskDef.proxyConfiguration.type == 'APPMESH' && taskDef.proxyConfiguration.properties && taskDef.proxyConfiguration.properties.length > 0;
}

// Deploy to a service that uses the 'CODE_DEPLOY' deployment controller
async function createCodeDeployDeployment(codedeploy, clusterName, service, taskDefArn, waitForService, waitForMinutes) {
  core.debug('Updating AppSpec file with new task definition ARN');

  let codeDeployAppSpecFile = core.getInput('codedeploy-appspec', { required : false });
  codeDeployAppSpecFile = codeDeployAppSpecFile ? codeDeployAppSpecFile : 'appspec.yaml';

  let codeDeployApp = core.getInput('codedeploy-application', { required: false });
  codeDeployApp = codeDeployApp ? codeDeployApp : `AppECS-${clusterName}-${service}`;

  let codeDeployGroup = core.getInput('codedeploy-deployment-group', { required: false });
  codeDeployGroup = codeDeployGroup ? codeDeployGroup : `DgpECS-${clusterName}-${service}`;

  let codeDeployDescription = core.getInput('codedeploy-deployment-description', { required: false });

  let deploymentGroupDetails = await codedeploy.getDeploymentGroup({
    applicationName: codeDeployApp,
    deploymentGroupName: codeDeployGroup
  }).promise();
  deploymentGroupDetails = deploymentGroupDetails.deploymentGroupInfo;

  // Insert the task def ARN into the appspec file
  const appSpecPath = path.isAbsolute(codeDeployAppSpecFile) ?
    codeDeployAppSpecFile :
    path.join(process.env.GITHUB_WORKSPACE, codeDeployAppSpecFile);
  const fileContents = fs.readFileSync(appSpecPath, 'utf8');
  const appSpecContents = yaml.parse(fileContents);

  for (var resource of findAppSpecValue(appSpecContents, 'resources')) {
    for (var name in resource) {
      const resourceContents = resource[name];
      const properties = findAppSpecValue(resourceContents, 'properties');
      const taskDefKey = findAppSpecKey(properties, 'taskDefinition');
      properties[taskDefKey] = taskDefArn;
    }
  }

  const appSpecString = JSON.stringify(appSpecContents);
  const appSpecHash = crypto.createHash('sha256').update(appSpecString).digest('hex');

  // Start the deployment with the updated appspec contents
  core.debug('Starting CodeDeploy deployment');
  let deploymentParams = {
    applicationName: codeDeployApp,
    deploymentGroupName: codeDeployGroup,
    revision: {
      revisionType: 'AppSpecContent',
      appSpecContent: {
        content: appSpecString,
        sha256: appSpecHash
      }
    }
  };

  // If it hasn't been set then we don't even want to pass it to the api call to maintain previous behaviour.
  if (codeDeployDescription) {
    // CodeDeploy Deployment Descriptions have a max length of 512 characters, so truncate if necessary
    deploymentParams.description = (codeDeployDescription.length <= 512) ? codeDeployDescription : `${codeDeployDescription.substring(0,511)}…`;
  }
  const createDeployResponse = await codedeploy.createDeployment(deploymentParams).promise();
  core.setOutput('codedeploy-deployment-id', createDeployResponse.deploymentId);
  core.info(`Deployment started. Watch this deployment's progress in the AWS CodeDeploy console: https://console.aws.amazon.com/codesuite/codedeploy/deployments/${createDeployResponse.deploymentId}?region=${aws.config.region}`);

  // Wait for deployment to complete
  if (waitForService && waitForService.toLowerCase() === 'true') {
    // Determine wait time
    const deployReadyWaitMin = deploymentGroupDetails.blueGreenDeploymentConfiguration.deploymentReadyOption.waitTimeInMinutes;
    const terminationWaitMin = deploymentGroupDetails.blueGreenDeploymentConfiguration.terminateBlueInstancesOnDeploymentSuccess.terminationWaitTimeInMinutes;
    let totalWaitMin = deployReadyWaitMin + terminationWaitMin + waitForMinutes;
    if (totalWaitMin > MAX_WAIT_MINUTES) {
      totalWaitMin = MAX_WAIT_MINUTES;
    }
    const maxAttempts = (totalWaitMin * 60) / WAIT_DEFAULT_DELAY_SEC;

    core.debug(`Waiting for the deployment to complete. Will wait for ${totalWaitMin} minutes`);
    await codedeploy.waitFor('deploymentSuccessful', {
      deploymentId: createDeployResponse.deploymentId,
      $waiter: {
        delay: WAIT_DEFAULT_DELAY_SEC,
        maxAttempts: maxAttempts
      }
    }).promise();
  } else {
    core.debug('Not waiting for the deployment to complete');
  }
}

async function run() {
  try {
    const ecs = new aws.ECS({
      customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
    });
    const codedeploy = new aws.CodeDeploy({
      customUserAgent: 'amazon-ecs-deploy-task-definition-for-github-actions'
    });

    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', { required: true });
    const service = core.getInput('service', { required: false });
    const cluster = core.getInput('cluster', { required: false });
    const waitForService = core.getInput('wait-for-service-stability', { required: false });
    let waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 30;
    if (waitForMinutes > MAX_WAIT_MINUTES) {
      waitForMinutes = MAX_WAIT_MINUTES;
    }

    const forceNewDeployInput = core.getInput('force-new-deployment', { required: false }) || 'false';
    const forceNewDeployment = forceNewDeployInput.toLowerCase() === 'true';

    const shouldUseTaskARNInput = core.getInput('run-task-use-arn', { required: false }) || 'false';
    const shouldUseTaskARN = shouldUseTaskARNInput.toLowerCase() === 'true';

    // Register the task definition or use passed in ARN
    let taskDefArn;
    if (shouldUseTaskARN) {
      core.debug(`Using pre-existing task definition: ${taskDefinitionFile}`)
      taskDefArn = taskDefinitionFile;
    } else {
      core.debug('Registering the task definition');
      const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
        taskDefinitionFile :
        path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
      const fileContents = fs.readFileSync(taskDefPath, 'utf8');
      const taskDefContents = maintainValidObjects(removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents))));
      let registerResponse;
      try {
        registerResponse = await ecs.registerTaskDefinition(taskDefContents).promise();
      } catch (error) {
        core.setFailed("Failed to register task definition in ECS: " + error.message);
        core.debug("Task definition contents:");
        core.debug(JSON.stringify(taskDefContents, undefined, 4));
        throw(error);
      }
      taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
    }
    core.setOutput('task-definition-arn', taskDefArn);

    // Run the task outside of the service
    const clusterName = cluster ? cluster : 'default';
    const shouldRunTaskInput = core.getInput('run-task', { required: false }) || 'false';
    const shouldRunTask = shouldRunTaskInput.toLowerCase() === 'true';
    core.debug(`shouldRunTask: ${shouldRunTask}`);
    if (shouldRunTask) {
      core.debug("Running ad-hoc task...");
      await runTask(ecs, clusterName, taskDefArn, waitForMinutes);
    }

    // Update the service with the new task definition
    if (service) {
      // Determine the deployment controller
      const describeResponse = await ecs.describeServices({
        services: [service],
        cluster: clusterName
      }).promise();

      if (describeResponse.failures && describeResponse.failures.length > 0) {
        const failure = describeResponse.failures[0];
        throw new Error(`${failure.arn} is ${failure.reason}`);
      }

      const serviceResponse = describeResponse.services[0];
      if (serviceResponse.status != 'ACTIVE') {
        throw new Error(`Service is ${serviceResponse.status}`);
      }

      if (!serviceResponse.deploymentController || !serviceResponse.deploymentController.type || serviceResponse.deploymentController.type === 'ECS') {
        // Service uses the 'ECS' deployment controller, so we can call UpdateService
        await updateEcsService(ecs, clusterName, service, taskDefArn, waitForService, waitForMinutes, forceNewDeployment);
      } else if (serviceResponse.deploymentController.type === 'CODE_DEPLOY') {
        // Service uses CodeDeploy, so we should start a CodeDeploy deployment
        await createCodeDeployDeployment(codedeploy, clusterName, service, taskDefArn, waitForService, waitForMinutes);
      } else {
        throw new Error(`Unsupported deployment controller: ${serviceResponse.deploymentController.type}`);
      }
    } else {
      core.debug('Service was not specified, no service updated');
    }
  }
  catch (error) {
    core.setFailed(error.message);
    core.debug(error.stack);
  }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === module) {
    run();
}
