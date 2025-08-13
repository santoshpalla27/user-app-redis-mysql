output "aws_availability_zones" {
  description = "List of available AWS availability zones"
  value       = data.aws_availability_zones.available.names
}


output "instance_ips" {
  description = "Private IP addresses of the Redis EC2 instances"
  value       = aws_instance.redis[*].private_ip
}
