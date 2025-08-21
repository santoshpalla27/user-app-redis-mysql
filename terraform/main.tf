module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = var.vpc_name
  cidr = "10.0.0.0/16"

  azs             = slice(data.aws_availability_zones.available.names, 0, 3)
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  # Enable NAT Gateway
  enable_nat_gateway = true
  enable_vpn_gateway = false
  single_nat_gateway = true

  # Enable DNS hostnames and DNS resolution
  enable_dns_hostnames = true
  enable_dns_support   = true

  # Additional tags
  tags = {
    Terraform = "true"
  }

  # Tags for public subnets
  public_subnet_tags = {
    Type = "Public"
  }

  # Tags for private subnets
  private_subnet_tags = {
    Type = "Private"
  }
}


resource "tls_private_key" "key" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "generated" {
  key_name   = "terraform-key"
  public_key = tls_private_key.key.public_key_openssh
}

# Save the private key locally as .pem
resource "local_file" "pem" {
  filename        = "${path.module}/terraform-key.pem"
  content         = tls_private_key.key.private_key_pem
  file_permission = "0400" # Make it read-only
}

resource "aws_launch_template" "main-template" {
  name_prefix   = "main-template-"
  image_id      = var.ami_id
  instance_type = var.instance_type
  key_name      = aws_key_pair.generated.key_name


  user_data = base64encode(<<-EOF
#!/bin/bash
set -xe
yum install -y git ansible
git clone -b ec2-deployment-aws-services https://github.com/santoshpalla27/user-app-redis-mysql.git
cd user-app-redis-mysql/ansible
ansible-playbook frontend.yml
EOF
  )


  network_interfaces {
    security_groups             = [aws_security_group.ec2_sg.id]
    # associate_public_ip_address = true  # Uncomment if you want a public IP and the instance is in a public subnet
  }

  lifecycle {
    create_before_destroy = true
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "MainInstance"
    }
  }
}


resource "aws_lb" "frontend_alb" {
  name               = "${var.vpc_name}-frontend-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg.id]
  subnets            = module.vpc.public_subnets
  tags = {
    Name = "${var.vpc_name}-frontend-alb"
  }
}

resource "aws_lb_target_group" "frontend_tg" {
  name     = "${var.vpc_name}-frontend-tg"
  port     = 3000
  protocol = "HTTP"
  vpc_id   = module.vpc.vpc_id

  health_check {
    enabled             = true
    interval            = 30
    path                = "/"
    port                = "3000"
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200-299"
  }

  tags = {
    Name = "${var.vpc_name}-main-tg"
  }
}



resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.frontend_alb.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = aws_acm_certificate.multi_domain_cert.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend_tg.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.frontend_alb.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301" # Permanent redirect
    }
  }
}



resource "aws_autoscaling_group" "frontend" {
  name                      = "frontend-asg"
  min_size                  = 1
  max_size                  = 1
  desired_capacity          = 1
  vpc_zone_identifier       = module.vpc.private_subnets
  health_check_type         = "ELB"
  health_check_grace_period = 300
  force_delete              = true
  target_group_arns         = [aws_lb_target_group.frontend_tg.arn]

  mixed_instances_policy {
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.main-template.id
        version            = "$Latest"
      }

      # # Optional: override instance types (different from launch_template's default)
      # override {
      #   instance_type = "t2.medium"
      # }

      # override {
      #   instance_type = "t3.medium"
      # }

      # override {
      #   instance_type = "t3a.medium"
      # }
    }

    instances_distribution {
      on_demand_base_capacity                  = 1                    # Start with 1 On-Demand
      on_demand_percentage_above_base_capacity = 20                   # 20% of instances will be On-Demand
      spot_allocation_strategy                 = "capacity-optimized" # or "lowest-price"
    }
  }

  tag {
    key                 = "asg-backend-instance"
    value               = "asg-backend-instance"
    propagate_at_launch = true
  }
}


# Scale Up Policy
resource "aws_autoscaling_policy" "scale_up_frontend" {
  name                   = "scale-up"
  scaling_adjustment     = 1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 300
  autoscaling_group_name = aws_autoscaling_group.frontend.name
}


resource "aws_cloudwatch_metric_alarm" "high_cpu_frontend" {
  alarm_name          = "high-cpu-usage"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 120
  statistic           = "Average"
  threshold           = 70

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.frontend.name
  }

  alarm_description = "Scale up if CPU usage is above 70% for 4 minutes"
  alarm_actions     = [aws_autoscaling_policy.scale_up_frontend.arn]
}


# Scale Down Policy
resource "aws_autoscaling_policy" "scale_down_frontend" {
  name                   = "scale-down"
  scaling_adjustment     = -1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 300
  autoscaling_group_name = aws_autoscaling_group.frontend.name
}

# CloudWatch Alarm to trigger Scale Down Policy
resource "aws_cloudwatch_metric_alarm" "low_cpu_frontend" {
  alarm_name          = "low-cpu-usage"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 120
  statistic           = "Average"
  threshold           = 40

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.frontend.name
  }

  alarm_description = "Scale down if CPU usage is below 40% for 4 minutes"
  alarm_actions     = [aws_autoscaling_policy.scale_down_frontend.arn]
}

################################################################################################
#  this is used when we have multiple target groups and listeners or have frontend and backend on same ALB
#################################################################################################


# resource "aws_lb_listener_rule" "frontend_main" {
#   listener_arn = aws_lb_listener.https.arn
#   priority     = 110

#   action {
#     type             = "forward"
#     target_group_arn = aws_lb_target_group.frontend_tg.arn
#   }

#   condition {
#     host_header {
#       values = ["santosh.website"]
#     }
#   }
# }

# resource "aws_lb_listener_rule" "backend_api" {
#   listener_arn = aws_lb_listener.https.arn
#   priority     = 100

#   action {
#     type             = "forward"
#     target_group_arn = aws_lb_target_group.backend.arn
#   }

#   # condition {
#   #   path_pattern {
#   #     values = ["/record", "/record/*" , "/health"]
#   #   }
#   # }
#   condition {
#     host_header {
#       values = ["backend.santosh.website"]
#     }
#   }
# }

#######################################################################################################

resource "aws_iam_role" "backend_ec2_role" {
  name = "backend-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_policy" "elasticache_readonly" {
  name        = "ElastiCacheReadOnly"
  description = "Read-only access to ElastiCache clusters and endpoints"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "elasticache:DescribeCacheClusters",
          "elasticache:DescribeReplicationGroups",
          "elasticache:ListTagsForResource",
          "elasticache:DescribeCacheSubnetGroups"
        ]
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}


# Attach the EC2 Full Access policy to the IAM role
resource "aws_iam_policy_attachment" "ec2_readonly" {
  name       = "ec2-readonly-attachment"
  roles      = [aws_iam_role.backend_ec2_role.name]
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess"
}

resource "aws_iam_policy_attachment" "rds_readonly" {
  name       = "rds-readonly-attachment"
  roles      = [aws_iam_role.backend_ec2_role.name]
  policy_arn = "arn:aws:iam::aws:policy/AmazonRDSReadOnlyAccess"
}

resource "aws_iam_policy_attachment" "elasticache_readonly" {
  name       = "elasticache-readonly-attachment"
  roles      = [aws_iam_role.backend_ec2_role.name]
  policy_arn = aws_iam_policy.elasticache_readonly.arn
}


# Create an IAM instance profile for the role
resource "aws_iam_instance_profile" "backend-ec2_profile" {
  name = "backend-ec2-profile"
  role = aws_iam_role.backend_ec2_role.name
}


resource "aws_launch_template" "backend-template" {
  name_prefix   = "main-template-"
  image_id      = var.ami_id
  instance_type = var.instance_type
  key_name      = aws_key_pair.generated.key_name
  iam_instance_profile {
    name = aws_iam_instance_profile.backend-ec2_profile.name
  }

  user_data = base64encode(<<-EOF
#!/bin/bash
set -xe
yum install -y git ansible
git clone -b ec2-deployment-aws-services https://github.com/santoshpalla27/user-app-redis-mysql.git
cd user-app-redis-mysql/ansible
ansible-playbook backend.yml
EOF
  )


  network_interfaces {
    security_groups             = [aws_security_group.ec2_sg.id]
    # associate_public_ip_address = true  # Uncomment if you want a public IP and the instance is in a public subnet
  }

  lifecycle {
    create_before_destroy = true
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "MainInstance"
    }
  }
}


resource "aws_lb" "backend_alb" {
  name               = "${var.vpc_name}-backend-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg.id]
  subnets            = module.vpc.public_subnets
  tags = {
    Name = "${var.vpc_name}-backend-alb"
  }
}

resource "aws_lb_target_group" "backend_tg" {
  name     = "${var.vpc_name}-backend-tg"
  port     = 5000
  protocol = "HTTP"
  vpc_id   = module.vpc.vpc_id

  health_check {
    enabled             = true
    interval            = 30
    path                = "/api/health"
    port                = "5000"
    protocol            = "HTTP"
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200-299"
  }

  tags = {
    Name = "${var.vpc_name}-main-tg"
  }
}



resource "aws_lb_listener" "backend_https" {
  load_balancer_arn = aws_lb.backend_alb.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = aws_acm_certificate.multi_domain_cert.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend_tg.arn
  }
}


resource "aws_lb_listener" "http_redirect_backend" {
  load_balancer_arn = aws_lb.backend_alb.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301" # Permanent redirect
    }
  }
}


resource "aws_autoscaling_group" "backend" {
  name                      = "backend-asg"
  min_size                  = 1
  max_size                  = 1
  desired_capacity          = 1
  vpc_zone_identifier       = module.vpc.private_subnets
  health_check_type         = "ELB"
  health_check_grace_period = 300
  force_delete              = true
  target_group_arns         = [aws_lb_target_group.backend_tg.arn]

  mixed_instances_policy {
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.backend-template.id
        version            = "$Latest"
      }

      # # Optional: override instance types (different from launch_template's default)
      # override {
      #   instance_type = "t2.medium"
      # }

      # override {
      #   instance_type = "t3.medium"
      # }

      # override {
      #   instance_type = "t3a.medium"
      # }
    }

    instances_distribution {
      on_demand_base_capacity                  = 1                    # Start with 1 On-Demand
      on_demand_percentage_above_base_capacity = 20                   # 20% of instances will be On-Demand
      spot_allocation_strategy                 = "capacity-optimized" # or "lowest-price"
    }
  }

  tag {
    key                 = "asg-backend-instance"
    value               = "asg-backend-instance"
    propagate_at_launch = true
  }


  # depends_on = [ module.rds , module.elasticache_redis ]
  depends_on = [ aws_elasticache_replication_group.redis_rg , aws_db_instance.db ]
}


# Scale Up Policy
resource "aws_autoscaling_policy" "scale_up_backend" {
  name                   = "scale-up"
  scaling_adjustment     = 1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 300
  autoscaling_group_name = aws_autoscaling_group.backend.name
}


resource "aws_cloudwatch_metric_alarm" "high_cpu_backend" {
  alarm_name          = "high-cpu-usage"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 120
  statistic           = "Average"
  threshold           = 70

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.backend.name
  }

  alarm_description = "Scale up if CPU usage is above 70% for 4 minutes"
  alarm_actions     = [aws_autoscaling_policy.scale_up_backend.arn]
}


# Scale Down Policy
resource "aws_autoscaling_policy" "scale_down_backend" {
  name                   = "scale-down"
  scaling_adjustment     = -1
  adjustment_type        = "ChangeInCapacity"
  cooldown               = 300
  autoscaling_group_name = aws_autoscaling_group.backend.name
}

# CloudWatch Alarm to trigger Scale Down Policy
resource "aws_cloudwatch_metric_alarm" "low_cpu_backend" {
  alarm_name          = "low-cpu-usage"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 120
  statistic           = "Average"
  threshold           = 40

  dimensions = {
    AutoScalingGroupName = aws_autoscaling_group.backend.name
  }

  alarm_description = "Scale down if CPU usage is below 40% for 4 minutes"
  alarm_actions     = [aws_autoscaling_policy.scale_down_backend.arn]
}







#=================================================================================================



resource "aws_instance" "check" {
  ami                         = var.ami_id
  instance_type               = var.instance_type
  subnet_id                   = module.vpc.public_subnets[0]
  key_name                    = aws_key_pair.generated.key_name
  vpc_security_group_ids      = [aws_security_group.my_sql_sg.id]
  iam_instance_profile = aws_iam_instance_profile.backend-ec2_profile.name
  associate_public_ip_address = true
  tags = {
    Name = "my-instance"
  }
}
