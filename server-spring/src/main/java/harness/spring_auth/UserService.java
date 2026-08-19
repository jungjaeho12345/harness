package harness.spring_auth;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

/**
 * 사용자 생성/수정 — src/services/userService.js create/update와 동형. 비밀번호는 bcrypt 해시로 저장하고
 * 응답에는 password·잠금 메타를 담지 않는다(SAFE_FIELDS 6키). 수정은 NewsDb.updateUser 화이트리스트 경유.
 */
public class UserService {

	private static final BCryptPasswordEncoder BCRYPT = new BCryptPasswordEncoder();
	// 생성 시 저장 가능한 입력 필드(비밀번호는 해시로 변환해 저장). active 미지정은 'Y'.
	private static final String[] CREATE_FIELDS = { "userId", "name", "role", "department", "departmentCode" };

	private final NewsDb db;

	public UserService(NewsDb db) {
		this.db = db;
	}

	private static String asStr(Object v) {
		return v == null ? null : String.valueOf(v);
	}

	/** 사용자 생성 — 비밀번호 bcrypt(cost 10) 해시 저장. 반환 {ok:true, user:6키(비밀번호 없음)}. */
	public Map<String, Object> create(Map<String, Object> dto) {
		Map<String, String> row = new LinkedHashMap<>();
		for (String f : CREATE_FIELDS) {
			if (dto.containsKey(f)) {
				row.put(f, asStr(dto.get(f)));
			}
		}
		row.put("password", BCRYPT.encode(asStr(dto.getOrDefault("password", ""))));
		row.put("active", dto.get("active") == null ? "Y" : asStr(dto.get("active")));
		db.insertUser(row);

		Map<String, Object> user = new LinkedHashMap<>();
		for (String f : CREATE_FIELDS) {
			user.put(f, row.get(f));
		}
		user.put("active", row.get("active"));
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put("user", user);
		return out;
	}

	/** 사용자 수정 — 화이트리스트 컬럼만(updateUser가 강제). 반환 {ok:true, changes:n}. */
	public Map<String, Object> update(String userId, Map<String, Object> fields) {
		Map<String, String> patch = new LinkedHashMap<>();
		for (Map.Entry<String, Object> e : fields.entrySet()) {
			patch.put(e.getKey(), asStr(e.getValue()));
		}
		int changes = db.updateUser(userId, patch);
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("ok", true);
		out.put("changes", changes);
		return out;
	}
}
