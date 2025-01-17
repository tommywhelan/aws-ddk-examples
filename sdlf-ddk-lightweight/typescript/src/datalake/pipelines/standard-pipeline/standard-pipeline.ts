import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {
  BaseStack,
  BaseStackProps,
  DataPipeline,
  S3EventStage
} from 'aws-ddk-core';
import { Construct } from 'constructs';
import { FoundationsStack } from '../../foundations';
import { SDLFHeavyTransform, SDLFLightTransform } from '../common-stages';
import {
  StandardDatasetConfig,
  StandardDatasetStack
} from './standard-dataset-stack';

const PIPELINE_TYPE = 'standard';

function getSsmValue(
  scope: Construct,
  id: string,
  parameterName: string
): string {
  return ssm.StringParameter.fromStringParameterName(scope, id, parameterName)
    .stringValue;
}

export interface StandardPipelineProps extends BaseStackProps {
  readonly environmentId: string;
  readonly resourcePrefix: string;
  readonly team: string;
  readonly foundationsStage: FoundationsStack;
  readonly wranglerLayer: lambda.ILayerVersion;
  readonly app: string;
  readonly org: string;
  readonly runtime: lambda.Runtime;
}

interface CreateSdlfPipelineResult {
  readonly s3EventCaptureStage: S3EventStage;
  readonly datalakeLightTransform: SDLFLightTransform;
  readonly datalakeHeavyTransform: SDLFHeavyTransform;
  readonly routingB: lambda.IFunction;
  readonly datalakePipeline: DataPipeline;
}

export class StandardPipeline extends BaseStack {
  readonly resourcePrefix: string;
  readonly team: string;
  readonly foundationsStage: FoundationsStack;
  readonly wranglerLayer: lambda.ILayerVersion;
  readonly pipelineId: string;
  readonly datalakeLibraryLayerArn: string;
  readonly datalakeLibraryLayer: lambda.ILayerVersion;
  readonly app: string;
  readonly org: string;
  readonly runtime: lambda.Runtime;
  readonly environmentId: string;

  readonly s3EventCaptureStage: S3EventStage;
  readonly datalakeLightTransform: SDLFLightTransform;
  readonly datalakeHeavyTransform: SDLFHeavyTransform;
  readonly routingB: lambda.IFunction;
  readonly datalakePipeline: DataPipeline;

  constructor(scope: Construct, id: string, props: StandardPipelineProps) {
    super(scope, id, props);
    this.team = props.team;
    this.app = props.app;
    this.org = props.org;
    this.runtime = props.runtime;
    this.resourcePrefix = props.resourcePrefix;
    this.pipelineId = `${this.resourcePrefix}-${this.team}-${PIPELINE_TYPE}`;
    this.environmentId = props.environmentId;
    this.wranglerLayer = props.wranglerLayer;
    this.foundationsStage = props.foundationsStage;
    this.datalakeLibraryLayerArn = getSsmValue(
      this,
      'data-lake-library-layer-arn-ssm',
      '/SDLF/Layer/DataLakeLibrary'
    );
    this.datalakeLibraryLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'data-lake-library-layer',
      this.datalakeLibraryLayerArn
    );

    ({
      s3EventCaptureStage: this.s3EventCaptureStage,
      routingB: this.routingB,
      datalakeLightTransform: this.datalakeLightTransform,
      datalakeHeavyTransform: this.datalakeHeavyTransform,
      datalakePipeline: this.datalakePipeline
    } = this.createSdlfPipeline());
  }

  protected createSdlfPipeline(): CreateSdlfPipelineResult {
    // routing function
    const routingFunction = this.createRoutingLambda();

    // S3 Event Capture Stage
    const s3EventCaptureStage = new S3EventStage(
      this,
      `${this.pipelineId}-s3-event-capture`,
      {
        eventNames: ['Object Created'],
        bucket: this.foundationsStage.rawBucket
      }
    );

    const datalakeLightTransform = new SDLFLightTransform(
      this,
      `${this.pipelineId}-stage-a`,
      {
        name: `${this.resourcePrefix}-SDLFLightTransform-${this.team}-${PIPELINE_TYPE}-${this.environmentId}`,
        prefix: this.resourcePrefix,
        environmentId: this.environmentId,
        config: {
          team: this.team,
          pipeline: PIPELINE_TYPE,
          rawBucket: this.foundationsStage.rawBucket,
          rawBucketKey: this.foundationsStage.rawBucketKey,
          stageBucket: this.foundationsStage.stageBucket,
          stageBucketKey: this.foundationsStage.stageBucketKey,
          routingLambda: routingFunction,
          datalakeLib: this.datalakeLibraryLayer,
          registerProvider: this.foundationsStage.registerProvider,
          wranglerLayer: this.wranglerLayer,
          runtime: this.runtime
        },
        props: {
          version: 1,
          status: 'ACTIVE',
          name: `${this.team}-${PIPELINE_TYPE}-stage-a`,
          type: 'octagon_pipeline',
          description: `${this.resourcePrefix} data lake light transform`,
          id: `${this.team}-${PIPELINE_TYPE}-stage-a`
        },
        description: `${this.resourcePrefix} data lake light transform`
      }
    );

    const datalakeHeavyTransform = new SDLFHeavyTransform(
      this,
      `${this.pipelineId}-stage-b`,
      {
        name: `${this.resourcePrefix}-SDLFHeavyTransform-${this.team}-${PIPELINE_TYPE}-${this.environmentId}`,
        prefix: this.resourcePrefix,
        environmentId: this.environmentId,
        config: {
          team: this.team,
          pipeline: PIPELINE_TYPE,
          stageBucket: this.foundationsStage.stageBucket,
          stageBucketKey: this.foundationsStage.stageBucketKey,
          datalakeLib: this.datalakeLibraryLayer,
          registerProvider: this.foundationsStage.registerProvider,
          wranglerLayer: this.wranglerLayer,
          runtime: this.runtime
        },
        props: {
          version: 1,
          status: 'ACTIVE',
          name: `${this.team}-${PIPELINE_TYPE}-stage-b`,
          type: 'octagon_pipeline',
          description: `${this.resourcePrefix} data lake heavy transform`,
          id: `${this.team}-${PIPELINE_TYPE}-stage-b`
        },
        description: `${this.resourcePrefix} data lake heavy transform`
      }
    );
    const routingB = datalakeHeavyTransform.routingLambda;

    const datalakePipeline = new DataPipeline(this, this.pipelineId, {
      name: `${this.resourcePrefix}-DataPipeline-${this.team}-${PIPELINE_TYPE}-${this.environmentId}`,
      description: `${this.resourcePrefix} data lake pipeline`
    })
      .addStage({ stage: this.s3EventCaptureStage })
      .addStage({ stage: this.datalakeLightTransform, skipRule: true })
      .addStage({ stage: datalakeHeavyTransform, skipRule: true });

    return {
      routingB,
      s3EventCaptureStage,
      datalakeHeavyTransform,
      datalakeLightTransform,
      datalakePipeline
    };
  }

  protected createRoutingLambda(): lambda.IFunction {
    // Lambda
    const routingFunction = new lambda.Function(
      this,
      `${this.resourcePrefix}-${this.team}-${PIPELINE_TYPE}-pipeline-routing-function`,
      {
        functionName: `${this.resourcePrefix}-${this.team}-${PIPELINE_TYPE}-pipeline-routing`,
        code: lambda.Code.fromAsset(
          path.join(__dirname, '../../src/lambdas/routing')
        ),
        handler: 'handler.lambda_handler',
        description: 'routes to the right team and pipeline',
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        runtime: this.runtime,
        environment: {
          ENV: this.environmentId,
          APP: this.app,
          ORG: this.org,
          PREFIX: this.resourcePrefix
        }
      }
    );
    this.foundationsStage.objectMetadata.grantReadWriteData(routingFunction);
    this.foundationsStage.datasets.grantReadWriteData(routingFunction);
    routingFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:CreateGrant',
          'kms:Decrypt',
          'kms:DescribeKey',
          'kms:Encrypt',
          'kms:GenerateDataKey',
          'kms:GenerateDataKeyPair',
          'kms:GenerateDataKeyPairWithoutPlaintext',
          'kms:GenerateDataKeyWithoutPlaintext',
          'kms:ReEncryptTo',
          'kms:ReEncryptFrom',
          'kms:ListAliases',
          'kms:ListGrants',
          'kms:ListKeys',
          'kms:ListKeyPolicies'
        ],
        resources: ['*'],
        conditions: {
          'ForAnyValue:StringLike': {
            'kms:ResourceAliases': 'alias/*'
          }
        }
      })
    );
    routingFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'sqs:SendMessage',
          'sqs:DeleteMessage',
          'sqs:ReceiveMessage',
          'sqs:GetQueueAttributes',
          'sqs:ListQueues',
          'sqs:GetQueueUrl',
          'sqs:ListDeadLetterSourceQueues',
          'sqs:ListQueueTags'
        ],
        resources: [
          `arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:${this.resourcePrefix}-*`
        ]
      })
    );
    routingFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/SDLF/*`
        ]
      })
    );

    routingFunction.addPermission('invoke-lambda-eventbridge', {
      principal: new iam.ServicePrincipal('events.amazonaws.com'),
      action: 'lambda:InvokeFunction'
    });
    return routingFunction;
  }

  public registerDataset(dataset: string, config: StandardDatasetConfig): void {
    // Create dataset stack
    const stageATransform = config.stageATransform ?? 'sdlf_light_transform';
    const stageBTransform = config.stageBTransform ?? 'sdlf_heavy_transform';

    new StandardDatasetStack(
      this,
      `${this.team}-${PIPELINE_TYPE}-${dataset}-dataset-stage`,
      {
        environmentId: this.environmentId,
        resourcePrefix: this.resourcePrefix,
        datasetConfig: {
          team: this.team,
          dataset: dataset,
          pipeline: PIPELINE_TYPE,
          app: this.app,
          org: this.org,
          routingB: this.routingB,
          stageATransform: stageATransform,
          stageBTransform: stageBTransform,
          artifactsBucket: this.foundationsStage.artifactsBucket,
          artifactsBucketKey: this.foundationsStage.artifactsBucketKey,
          stageBucket: this.foundationsStage.stageBucket,
          stageBucketKey: this.foundationsStage.stageBucketKey,
          glueRole: this.foundationsStage.glueRole,
          registerProvider: this.foundationsStage.registerProvider
        }
      }
    );

    // Add S3 object created event pattern
    const baseEventPattern = JSON.parse(
      JSON.stringify(this.s3EventCaptureStage.eventPattern)
    );
    if (baseEventPattern && baseEventPattern.detail) {
      baseEventPattern.detail['object'] = {
        key: [{ prefix: `${this.team}/${dataset}/` }]
      };
    }

    this.datalakePipeline.addRule({
      id: `standard-dataset-${dataset}-rule`,
      eventPattern: baseEventPattern,
      eventTargets: this.datalakeLightTransform.targets
    });
  }
}
