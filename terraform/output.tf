output "aws_availability_zones" {
  description = "List of available AWS availability zones"
  value       = data.aws_availability_zones.available.names
}

# output "rds_endpoint" {
#   description = "RDS endpoint"
#   value       = module.rds.db_instance_endpoint
# }

# output "rds_db_name" {
#   description = "RDS database name"
#   value       = module.rds.db_instance_name
# }

# output "redis_primary_endpoint" {
#   value = aws_elasticache_cluster.redis_cluster.cache_nodes[0].address
# }

# output "redis_port" {
#   value = aws_elasticache_cluster.redis_cluster.cache_nodes[0].port
# }


