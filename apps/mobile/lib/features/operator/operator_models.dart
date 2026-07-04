class DeviceCommand {
  DeviceCommand({
    required this.id,
    required this.status,
    required this.kind,
    required this.payload,
    required this.createdAt,
    this.expiresAt,
    this.result,
  });

  final String id;
  final String status;
  final String kind;
  final List<dynamic> payload;
  final Map<String, dynamic>? result;
  final DateTime createdAt;
  final DateTime? expiresAt;

  factory DeviceCommand.fromJson(Map<String, dynamic> json) => DeviceCommand(
        id: json['id'] as String,
        status: json['status'] as String,
        kind: json['kind'] as String,
        payload: (json['payload'] as List?) ?? const [],
        result: (json['result'] as Map?)?.cast<String, dynamic>(),
        createdAt: DateTime.parse(json['created_at'] as String),
        expiresAt: json['expires_at'] != null
            ? DateTime.parse(json['expires_at'] as String)
            : null,
      );
}
