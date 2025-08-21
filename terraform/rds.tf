variable "db_instance_class" {
  description = "The instance class for the RDS database."
  type        = string
  default     = "db.t4g.small"
}

resource "aws_db_subnet_group" "db_subnet_group" {
  name       = "user-app-db-subnet-group"
  subnet_ids = module.vpc.private_subnets

  tags = {
    Name = "User App DB Subnet Group"
  }
  
}

resource "aws_security_group" "db_sg" {
  name        = "user-app-db-sg"
  description = "Security group for User App RDS database"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 3306
    to_port     = 3306
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # Adjust this to restrict access as needed
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}


resource "aws_db_instance" "db" {
  identifier              = "mydb"
  engine                  = "mysql"
  engine_version          = "8.0"
  instance_class          = var.db_instance_class
  allocated_storage       = 20
  max_allocated_storage   = 100
  storage_type            = "gp2"
  username                = "admin"
  password                = "password"
  db_name                 = "userappdb"
  skip_final_snapshot     = true
  publicly_accessible     = false
  vpc_security_group_ids  = [aws_security_group.db_sg.id]
  db_subnet_group_name    = aws_db_subnet_group.db_subnet_group.name
}


# module "rds" {
#   source  = "terraform-aws-modules/rds/aws"
#   version = "6.8.0"

#   identifier = "mydb"
#   engine     = "mysql"
#   engine_version = "8.0"
#   instance_class = var.db_instance_class
#   allocated_storage = 20
#   max_allocated_storage = 100
#   storage_type = "gp2"

#   db_name  = "userappdb"
#   username = "admin"
#   password = "password"

#   vpc_security_group_ids = [aws_security_group.db_sg.id]
#   subnet_ids             = module.vpc.private_subnets

#   publicly_accessible    = false
#   skip_final_snapshot    = true

#   # Removed configurations that weren't in the native resource version
#   # multi_az               = false
#   # deletion_protection    = false
#   # backup_retention_period = 7
#   # maintenance_window      = "Mon:00:00-Mon:03:00"
#   # backup_window           = "03:00-06:00"
#   # family               = "mysql8.0"
#   # major_engine_version = "8.0"
# }



