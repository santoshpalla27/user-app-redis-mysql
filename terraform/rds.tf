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
    cidr_blocks = ["0.0.0/0"] # Adjust this to restrict access as needed
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0/0"]
  }
}


# resource "aws_db_instance" "db" {
#   identifier              = "user-app-db"
#   engine                  = "mysql"
#   engine_version          = "8.0"
#   instance_class          = var.db_instance_class
#   allocated_storage       = 20
#   max_allocated_storage   = 100
#   storage_type            = "gp2"
#   username                = "admin"
#   password                = "password"
#   db_name                 = "userappdb"
#   skip_final_snapshot     = true
#   publicly_accessible     = false
#   vpc_security_group_ids  = [aws_security_group.db_sg.id]
#   db_subnet_group_name    = aws_db_subnet_group.db_subnet_group.name
# }



module "rds" {
  source  = "terraform-aws-modules/rds/aws"
  version = "6.8.0"

  identifier = "mydb"
  engine     = "mysql"
  instance_class = var.db_instance_class
  allocated_storage = 20

  db_name  = "appdb"
  username = "admin"
  password = "password"

  vpc_security_group_ids = [aws_security_group.db_sg.id]
  subnet_ids             = module.vpc.private_subnets

  multi_az               = false   # for HA use true
  publicly_accessible    = false   # keep private
  skip_final_snapshot    = true
  deletion_protection    = false   # set true in prod

  backup_retention_period = 7
  maintenance_window      = "Mon:00:00-Mon:03:00"
  backup_window           = "03:00-06:00"
}
