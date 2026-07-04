List<Map<String, dynamic>> unwrapList(dynamic body) {
  final list = body is List
      ? body
      : (body is Map
            ? ((body['items'] ?? body['data']) as List? ?? const [])
            : const []);
  return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
}

class Approval {
  Approval({
    required this.id,
    required this.action,
    required this.status,
    required this.riskLevel,
    this.reason,
    this.amount,
    this.subject,
    this.channel,
    this.draftText,
    this.createdAt,
    this.confidence,
    this.tokenCost,
    this.citations = const [],
  });

  final String id;
  final String action;
  final String status;
  final String riskLevel;
  final String? reason;
  final num? amount;
  final String? subject;
  final String? channel;
  final String? draftText;
  final DateTime? createdAt;
  final double? confidence;
  final num? tokenCost;
  final List<String> citations;

  factory Approval.fromJson(Map<String, dynamic> j) {
    final payload = (j['payload'] as Map?)?.cast<String, dynamic>() ?? const {};
    final activity = (j['activity'] as Map?)?.cast<String, dynamic>();
    String? draft;
    for (final k in ['draft_text', 'content', 'body', 'message', 'text']) {
      final v = j[k] ?? payload[k];
      if (v is String && v.isNotEmpty) {
        draft = v;
        break;
      }
    }
    return Approval(
      id: j['id'] as String,
      action: (j['action'] ?? '?') as String,
      status: (j['status'] ?? 'pending') as String,
      riskLevel: (j['risk_level'] ?? 'medium') as String,
      reason: j['reason'] as String?,
      amount: j['amount'] is String
          ? num.tryParse(j['amount'] as String)
          : j['amount'] as num?,
      subject: activity?['subject'] as String?,
      channel: activity?['channel'] as String?,
      draftText: draft,
      createdAt: j['created_at'] != null
          ? DateTime.tryParse(j['created_at'] as String)
          : null,
      confidence: _double(
        j['confidence'] ?? payload['confidence'] ?? payload['confidence_score'],
      ),
      tokenCost: _num(
        j['token_cost'] ??
            payload['token_cost'] ??
            payload['tokens'] ??
            payload['cost_tokens'],
      ),
      citations: _citations(
        j['citations'] ?? payload['citations'] ?? payload['sources'],
      ),
    );
  }

  static double? _double(Object? value) {
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value);
    return null;
  }

  static num? _num(Object? value) {
    if (value is num) return value;
    if (value is String) return num.tryParse(value);
    return null;
  }

  static List<String> _citations(Object? value) {
    if (value is! List) return const [];
    return value
        .map((e) {
          if (e is Map) {
            return (e['title'] ?? e['url'] ?? e['id'] ?? e).toString();
          }
          return e.toString();
        })
        .where((e) => e.trim().isNotEmpty)
        .toList();
  }
}
