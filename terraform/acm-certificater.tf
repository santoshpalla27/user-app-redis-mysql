# # Data source for Route53 zone (moved to top for better organization)
# data "aws_route53_zone" "primary" {
#   name         = "santosh.website"
#   private_zone = false
# }

# Request ACM Certificate
resource "aws_acm_certificate" "multi_domain_cert" {
  domain_name       = "santosh.website"
  validation_method = "DNS"

  subject_alternative_names = ["*.santosh.website"]

  tags = {
    Name = "santosh.website-multi"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Create Route53 DNS validation records
resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.multi_domain_cert.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  zone_id = data.aws_route53_zone.primary.zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.record]

  allow_overwrite = true
}

# Validate the ACM certificate
resource "aws_acm_certificate_validation" "multi_domain_cert_validation" {
  certificate_arn         = aws_acm_certificate.multi_domain_cert.arn
  validation_record_fqdns = [for record in aws_route53_record.cert_validation : record.fqdn]

  timeouts {
    create = "5m"
  }
}