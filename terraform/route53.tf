
# Data source for Route53 zone (moved to top for better organization)
data "aws_route53_zone" "primary" {
  name         = "santosh.website"
  private_zone = false
}


resource "aws_route53_record" "frontend_route_53" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "santosh.website"
  type    = "A"
  
  alias {
    name                   = aws_lb.frontend_alb.dns_name
    zone_id                = aws_lb.frontend_alb.zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "backend_route_53" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "backend.santosh.website"
  type    = "A"
  
  alias {
    name                   = aws_lb.backend_alb.dns_name
    zone_id                = aws_lb.backend_alb.zone_id
    evaluate_target_health = false
  }
}