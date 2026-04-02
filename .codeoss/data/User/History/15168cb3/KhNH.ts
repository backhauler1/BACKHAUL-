import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class ChatAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Create a private S3 bucket for chat images
    const chatBucket = new s3.Bucket(this, 'ChatAppImagesBucket', {
      // In production, you might want RETAIN, but for development, DESTROY is easier.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // Automatically delete objects when the bucket is deleted
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // Enforce private access
      enforceSSL: true, // Require HTTPS
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.PUT],
          // IMPORTANT: Change this to your actual frontend URL in production
          allowedOrigins: ['http://localhost:3000', 'https://your-frontend-domain.com'],
          allowedHeaders: ['*'],
        },
      ],
    });

    // 2. Create an IAM user for the backend application
    const appUser = new iam.User(this, 'ChatAppBackendUser');

    // 3. Grant the user specific permissions to read and write to the 'chat-images/' folder
    const bucketPolicy = new iam.PolicyStatement({
      actions: [
        's3:PutObject', // For uploading new images
        's3:GetObject', // For generating signed URLs to view images
      ],
      resources: [
        chatBucket.arnForObjects('chat-images/*'),
      ],
    });

    appUser.addToPolicy(bucketPolicy);

    // 4. Create an access key for the user and store it securely in AWS Secrets Manager
    const accessKey = new iam.AccessKey(this, 'ChatAppUserAccessKey', { user: appUser });

    new secretsmanager.Secret(this, 'ChatAppUserCredentialsSecret', {
      secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({
        accessKeyId: accessKey.accessKeyId,
        secretAccessKey: accessKey.secretAccessKey.toString(),
      })),
      description: 'Access keys for the chat application backend user.',
    });

    // 5. Output the bucket name so we know what to put in our .env file
    new cdk.CfnOutput(this, 'BucketName', {
      value: chatBucket.bucketName,
      description: 'The name of the S3 bucket for chat images.',
    });

    new cdk.CfnOutput(this, 'Region', {
        value: this.region,
        description: 'The AWS region the stack was deployed in.',
    });
  }
}