terraform {
  required_version = ">= 1.3.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.8"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.20"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "The AWS region to deploy resources in"
  type        = string
  default     = "us-east-1"
}

variable "cluster_name" {
  description = "The name of the EKS cluster"
  type        = string
  default     = "user-app-eks-cluster"
}

# -----------------------
# VPC Module
# -----------------------
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.8.1"

  name = "eks-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["${var.region}a", "${var.region}b", "${var.region}c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = true

  tags = {
    Project                                         = "EKS-Demo"
    "kubernetes.io/cluster/${var.cluster_name}"     = "shared"
  }

  public_subnet_tags = {
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "owned"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"           = "1"
    "kubernetes.io/cluster/${var.cluster_name}" = "owned"
  }
}

# -----------------------
# EKS Module
# -----------------------
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "20.28.0"

  cluster_name    = var.cluster_name
  cluster_version = "1.30"

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  enable_cluster_creator_admin_permissions = true
  cluster_endpoint_public_access        = true
  cluster_endpoint_private_access       = false
  cluster_endpoint_public_access_cidrs  = ["0.0.0.0/0"]

  # Enable EKS addons
  cluster_addons = {
    coredns = {
      most_recent = true
    }
    kube-proxy = {
      most_recent = true
    }
    vpc-cni = {
      most_recent = true
    }
    aws-ebs-csi-driver = {
      most_recent              = true
      service_account_role_arn = module.ebs_csi_irsa_role.iam_role_arn
    }
  }

  eks_managed_node_groups = {
    # On-demand node group
    on_demand = {
      min_size       = 1
      max_size       = 2
      desired_size   = 1
      instance_types = ["m7i-flex.large"]
      capacity_type  = "ON_DEMAND"
    }

    # Spot node group
    spot_nodes = {
      min_size       = 1
      max_size       = 3
      desired_size   = 1
      instance_types = ["m7i-flex.large"]
      capacity_type  = "SPOT"
    }
  }

  tags = {
    Project = var.cluster_name
  }
}

# -----------------------
# Data sources for cluster info
# -----------------------
data "aws_eks_cluster" "demo" {
  name       = module.eks.cluster_name
  depends_on = [module.eks]
}

data "aws_eks_cluster_auth" "eks_cluster_auth" {
  name       = module.eks.cluster_name
  depends_on = [module.eks]
}

# -----------------------
# IRSA Roles for AWS Services
# -----------------------

# AWS Load Balancer Controller IRSA
module "aws_load_balancer_controller_irsa_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.32.0"

  role_name = "aws-load-balancer-controller"

  attach_load_balancer_controller_policy = true

  oidc_providers = {
    ex = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }

  tags = {
    Project = var.cluster_name
  }
}

# EBS CSI Driver IRSA
module "ebs_csi_irsa_role" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "5.32.0"

  role_name = "ebs-csi"

  attach_ebs_csi_policy = true

  oidc_providers = {
    ex = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }

  tags = {
    Project = var.cluster_name
  }
}

# -----------------------
# Kubernetes and Helm providers
# -----------------------
provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  token                  = data.aws_eks_cluster_auth.eks_cluster_auth.token
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    token                  = data.aws_eks_cluster_auth.eks_cluster_auth.token
  }
}

# -----------------------
# Helm Releases
# -----------------------

# AWS Load Balancer Controller
resource "helm_release" "aws_load_balancer_controller" {
  name       = "aws-load-balancer-controller"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  namespace  = "kube-system"
  version    = "1.8.1"

  set {
    name  = "clusterName"
    value = module.eks.cluster_name
  }

  set {
    name  = "serviceAccount.create"
    value = "true"
  }

  set {
    name  = "serviceAccount.name"
    value = "aws-load-balancer-controller"
  }

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = module.aws_load_balancer_controller_irsa_role.iam_role_arn
  }

  depends_on = [
    module.eks,
    module.aws_load_balancer_controller_irsa_role
  ]
}

# -----------------------
# IAM Roles for EC2 Instances
# -----------------------
data "aws_caller_identity" "current" {}

resource "aws_iam_role" "eks_instance_admin_role" {
  name = "eks-instance-admin-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_admin_attach" {
  role       = aws_iam_role.eks_instance_admin_role.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_instance_profile" "admin_instance_profile" {
  name = "eks-admin-instance-profile"
  role = aws_iam_role.eks_instance_admin_role.name
}

resource "aws_iam_role" "eks_instance_readonly_role" {
  name = "eks-instance-readonly-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "eks_readonly_policy" {
  name = "eks-readonly-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "eks:DescribeCluster",
          "eks:ListClusters",
          "eks:ListNodegroups",
          "eks:DescribeNodegroup",
          "eks:ListFargateProfiles",
          "eks:DescribeFargateProfile"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:DescribeAlarms",
          "cloudwatch:GetMetricData",
          "cloudwatch:ListMetrics"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "eks_readonly_attach" {
  role       = aws_iam_role.eks_instance_readonly_role.name
  policy_arn = aws_iam_policy.eks_readonly_policy.arn
}

resource "aws_iam_instance_profile" "readonly_instance_profile" {
  name = "eks-readonly-instance-profile"
  role = aws_iam_role.eks_instance_readonly_role.name
}

# IAM Roles for kubectl access
resource "aws_iam_role" "eks_user_role" {
  name = "eks-user-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_user_attach" {
  role       = aws_iam_role.eks_user_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

# -----------------------
# EKS Access Entries (replaces aws-auth ConfigMap)
# -----------------------
resource "aws_eks_access_entry" "admin_access" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.eks_instance_admin_role.arn
  type          = "STANDARD"

  depends_on = [module.eks]
}

resource "aws_eks_access_policy_association" "admin_access_policy" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.eks_instance_admin_role.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.admin_access]
}

resource "aws_eks_access_entry" "readonly_access" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.eks_instance_readonly_role.arn
  type          = "STANDARD"

  depends_on = [module.eks]
}

resource "aws_eks_access_policy_association" "readonly_access_policy" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.eks_instance_readonly_role.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"

  access_scope { type = "cluster" }

  depends_on = [aws_eks_access_entry.readonly_access]
}

resource "aws_eks_access_entry" "user_access" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.eks_user_role.arn
  type          = "STANDARD"

  depends_on = [module.eks]
}

resource "aws_eks_access_policy_association" "user_access_policy" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.eks_user_role.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy"

  access_scope { type = "cluster" }

  depends_on = [aws_eks_access_entry.user_access]
}


# -----------------------
# EC2 Key Pair
# -----------------------
resource "tls_private_key" "key" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  key_name   = "terraform-key"
  public_key = tls_private_key.key.public_key_openssh
}

resource "local_file" "pem" {
  filename        = "${path.module}/terraform-key.pem"
  content         = tls_private_key.key.private_key_pem
  file_permission = "0400"
}

# -----------------------
# EC2 Instances
# -----------------------
data "aws_ami" "amazon_linux_2" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*-x86_64-gp2"]
  }

  filter {
    name   = "state"
    values = ["available"]
  }
}

# Security group for EC2 instances
resource "aws_security_group" "ec2_sg" {
  name_prefix = "eks-ec2-sg"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "EKS-EC2-SG"
    Project = "EKS-Demo"
  }
}

resource "aws_instance" "admin_instance" {
  ami                         = data.aws_ami.amazon_linux_2.id
  instance_type               = "t3.micro"
  iam_instance_profile        = aws_iam_instance_profile.admin_instance_profile.name
  subnet_id                   = element(module.vpc.public_subnets, 0)
  vpc_security_group_ids      = [aws_security_group.ec2_sg.id]
  associate_public_ip_address = true
  key_name                    = aws_key_pair.generated.key_name

  user_data = <<-EOF
              #!/bin/bash
              set -e

              # Update system and install dependencies
              yum update -y
              yum install -y unzip curl jq tar gzip

              # Remove old AWS CLI v1 if present
              yum remove -y awscli || true

              # Install AWS CLI v2
              curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
              unzip -q awscliv2.zip
              sudo ./aws/install --update
              rm -rf awscliv2.zip aws

              # Install latest kubectl
              KUBECTL_VERSION=$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt)
              curl -LO "https://storage.googleapis.com/kubernetes-release/release/$${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
              chmod +x kubectl
              mv kubectl /usr/local/bin/

              # Configure kubeconfig for ec2-user
              runuser -l ec2-user -c "aws eks update-kubeconfig --name ${var.cluster_name} --region ${var.region}"

              # Verify install
              aws --version
              kubectl version --client
              EOF

  tags = {
    Name    = "EKS-Admin-Instance"
    Project = "EKS-Demo"
  }

  depends_on = [module.eks]
}

resource "aws_instance" "readonly_instance" {
  ami                         = data.aws_ami.amazon_linux_2.id
  instance_type               = "t3.micro"
  iam_instance_profile        = aws_iam_instance_profile.readonly_instance_profile.name
  subnet_id                   = element(module.vpc.public_subnets, 1)
  vpc_security_group_ids      = [aws_security_group.ec2_sg.id]
  associate_public_ip_address = true
  key_name                    = aws_key_pair.generated.key_name

  user_data = <<-EOF
              #!/bin/bash
              set -e

              # Update system and install dependencies
              yum update -y
              yum install -y unzip curl jq tar gzip

              # Remove old AWS CLI v1 if present
              yum remove -y awscli || true

              # Install AWS CLI v2
              curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
              unzip -q awscliv2.zip
              sudo ./aws/install --update
              rm -rf awscliv2.zip aws

              # Install latest kubectl
              KUBECTL_VERSION=$(curl -s https://storage.googleapis.com/kubernetes-release/release/stable.txt)
              curl -LO "https://storage.googleapis.com/kubernetes-release/release/$${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
              chmod +x kubectl
              mv kubectl /usr/local/bin/

              # Configure kubeconfig for ec2-user
              runuser -l ec2-user -c "aws eks update-kubeconfig --name ${var.cluster_name} --region ${var.region}"

              # Verify install
              aws --version
              kubectl version --client
              EOF

  tags = {
    Name    = "EKS-Readonly-Instance"
    Project = "EKS-Demo"
  }

  depends_on = [module.eks]
}

# -----------------------
# Outputs
# -----------------------
output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "cluster_security_group_id" {
  value = module.eks.cluster_security_group_id
}

output "admin_instance_ip" {
  value = aws_instance.admin_instance.public_ip
}

output "readonly_instance_ip" {
  value = aws_instance.readonly_instance.public_ip
}

output "ssh_key_path" {
  value = local_file.pem.filename
}