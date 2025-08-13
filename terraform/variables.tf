variable "aws_region" {
  description = "The AWS region to deploy resources in"
  type        = string
  default     = "us-east-1"
}

variable "vpc_name" {
  description = "The name of the VPC"
  type        = string
  default     = "ec2-deployment-vpc"
}

variable "ami_id" {
  description = "The AMI ID to use for the EC2 instance"
  type        = string
  default     = "ami-0de716d6197524dd9" # amazon-linux-2-x86_64-gp2
}

variable "instance_type" {
  description = "The type of EC2 instance to launch"
  type        = string
  default     = "c7i-flex.large" # Example instance type
}



variable "aws_region" {
  description = "The AWS region to create resources in"
  default     = "us-east-1"
}

variable "instance_count" {
  description = "Number of EC2 instances to create"
  default     = 4
}

variable "iam_role_name" {
  description = "Name of the IAM role for EC2 instances"
  default     = "redis-ec2-role"
}

variable "docker_image" {
  description = "Docker image for Redis"
  default     = "santoshpalla27/redis:latest"
}

variable "redis_password" {
  description = "Password for Redis instances"
  default     = "redis123"
}

