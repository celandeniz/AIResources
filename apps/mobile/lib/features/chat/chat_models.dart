class ChatResource {
  ChatResource({
    required this.id,
    required this.key,
    required this.name,
    this.role,
  });

  final String id;
  final String key;
  final String name;
  final String? role;

  factory ChatResource.fromJson(Map<String, dynamic> json) => ChatResource(
        id: json['id'] as String,
        key: json['key'] as String,
        name: (json['name'] ?? json['key']) as String,
        role: json['role'] as String?,
      );
}

class ChatThread {
  ChatThread({
    required this.id,
    this.subject,
    this.status,
    this.resourceId,
    this.resourceKey,
    this.resourceName,
    this.lastMessage,
    this.lastMessageAt,
  });

  final String id;
  final String? subject;
  final String? status;
  final String? resourceId;
  final String? resourceKey;
  final String? resourceName;
  final String? lastMessage;
  final DateTime? lastMessageAt;

  factory ChatThread.fromJson(Map<String, dynamic> json) {
    final resource = (json['resource'] as Map?)?.cast<String, dynamic>();
    return ChatThread(
      id: json['id'] as String,
      subject: json['subject'] as String?,
      status: json['status'] as String?,
      resourceId: resource?['id'] as String?,
      resourceKey: resource?['key'] as String?,
      resourceName: resource?['name'] as String?,
      lastMessage: json['last_message'] as String?,
      lastMessageAt: json['last_message_at'] != null
          ? DateTime.tryParse(json['last_message_at'] as String)
          : null,
    );
  }
}

class ChatMessage {
  ChatMessage({
    required this.id,
    required this.direction,
    required this.authorType,
    this.body,
    this.isDraft = false,
    this.createdAt,
  });

  final String id;
  final String direction;
  final String authorType;
  final String? body;
  final bool isDraft;
  final DateTime? createdAt;

  bool get isUser => direction == 'inbound';

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        id: json['id'] as String,
        direction: (json['direction'] ?? 'inbound') as String,
        authorType: (json['author_type'] ?? 'user') as String,
        body: json['body'] as String?,
        isDraft: (json['is_draft'] ?? false) as bool,
        createdAt: json['created_at'] != null
            ? DateTime.tryParse(json['created_at'] as String)
            : null,
      );
}

class ChatSendResult {
  ChatSendResult({
    required this.threadId,
    required this.reply,
    required this.toolIntentsPending,
  });

  final String threadId;
  final String reply;
  final bool toolIntentsPending;

  factory ChatSendResult.fromJson(Map<String, dynamic> json) => ChatSendResult(
        threadId: json['thread_id'] as String,
        reply: (json['reply'] ?? '') as String,
        toolIntentsPending: (json['tool_intents_pending'] ?? false) as bool,
      );
}
