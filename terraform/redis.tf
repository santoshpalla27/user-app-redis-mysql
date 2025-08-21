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

resource "aws_elasticache_parameter_group" "redis_cluster_pg" {
  family      = "redis7"
  name        = "redis-cluster-params"
  description = "Redis parameter group with cluster mode enabled"

  parameter {
    name  = "cluster-enabled"
    value = "yes"
  }

  # Optional: Add other parameters as needed
  # parameter {
  #   name  = "maxmemory-policy"
  #   value = "allkeys-lru"
  # }
}

resource "aws_elasticache_replication_group" "redis_rg" {
  replication_group_id = "redis-oss-rg"
  description          = "Redis replication group with cluster mode"

  engine         = "redis"
  engine_version = "7.0"
  node_type      = "cache.t3.micro"
  port           = 6379

  # Cluster mode configuration
  num_node_groups         = 2
  replicas_per_node_group = 1
  automatic_failover_enabled = true

  # Use the custom parameter group with cluster mode enabled
  parameter_group_name = aws_elasticache_parameter_group.redis_cluster_pg.name
  subnet_group_name    = aws_elasticache_subnet_group.redis_subnet_group.name
  security_group_ids   = [aws_security_group.redis_security_group.id]

  # Optional: Enable encryption
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  tags = {
    Name = "redis-oss-rg"
  }
}





# module "elasticache_redis" {
#   source  = "terraform-aws-modules/elasticache/aws"
#   version = "1.3.0"
#   replication_group_id   = "redis-oss-rg"   # 👈 Required
#   cluster_id           = "redis-oss-cluster"
#   engine               = "redis"
#   engine_version       = "7.1"
#   node_type            = "cache.t3.micro"
#   num_cache_clusters   = 1  # OSS Redis cluster must be >= 1
#   parameter_group_name = "default.redis7"

#   subnet_group_name   = module.vpc.database_subnet_group_name
#   security_group_ids  = [aws_security_group.redis_security_group.id]

#   maintenance_window        = "sun:03:00-sun:04:00"
#   snapshot_window           = "05:00-06:00"
#   snapshot_retention_limit  = 3
  
# }


