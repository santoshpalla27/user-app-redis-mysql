output "aws_availability_zones" {
  description = "List of available AWS availability zones"
  value       = data.aws_availability_zones.available.names
}


output "instance_ips" {
  description = "Private IP addresses of the Redis EC2 instances"
  value       = aws_instance.redis[*].private_ip
}



output "rds_endpoint" {
  description = "RDS endpoint"
  value       = module.rds.db_instance_endpoint
}

output "rds_db_name" {
  description = "RDS database name"
  value       = module.rds.db_instance_name
}

output "redis_primary_endpoint" {
  description = "Primary endpoint of the Redis cluster"
  value       = module.elasticache_redis.primary_endpoint_address
}

output "redis_port" {
  description = "Redis port"
  value       = module.elasticache_redis.port
}
