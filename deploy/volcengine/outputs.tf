output "instance_id" {
  description = "ECS instance ID."
  value       = bytepluscc_ecs_instance.launchpad.id
}

output "public_ip" {
  description = "ECS public IP."
  value       = bytepluscc_ecs_instance.launchpad.eip_address.ip_address
}

output "app_url" {
  description = "LQAM URL. Wait for cloud-init to finish before opening it."
  value       = "http://${bytepluscc_ecs_instance.launchpad.eip_address.ip_address}"
}
