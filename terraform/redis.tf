resource "aws_elasticache_subnet_group" "redis_subnet_group" {
  name       = "redis-subnet-group"
  subnet_ids = module.vpc.private_subnets

  tags = {
    Name = "redis-subnet-group"
  }
}

resource "aws_security_group" "redis_security_group" {
  name        = "redis-security-group"
  description = "Security group for Redis"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]  # Adjust this to restrict access as needed
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]  # Allow all outbound traffic
    }
}

resource "aws_elasticache_cluster" "redis_cluster" {
  cluster_id           = "redis-cluster"
  engine               = "redis"
  engine_version       = "7.0"  # Specify the desired Redis version
  node_type            = "cache.t3.micro"  # Adjust instance type as needed
  num_cache_nodes      = 1
  port                      = 6379
  parameter_group_name = "default.redis7"  # Use the default parameter group for Redis 6.x
  subnet_group_name    = aws_elasticache_subnet_group.redis_subnet_group.name
  security_group_ids   = [aws_security_group.redis_security_group.id]
  snapshot_retention_limit  = 0

  tags = {
    Name = "redis-cluster"
  }
  
}


module "elasticache_redis" {
  source  = "terraform-aws-modules/elasticache/aws"
  version = "1.3.0"

  cluster_id           = "redis-oss-cluster"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1 # OSS Redis cluster must be >= 1
  parameter_group_name = "default.redis7"

  subnet_group_name   = module.vpc.database_subnet_group_name
  security_group_ids  = [aws_security_group.redis_sg.id]

  maintenance_window        = "sun:03:00-sun:04:00"
  snapshot_window           = "05:00-06:00"
  snapshot_retention_limit  = 3
}