//#region src/yunzai/adapters/onebot-icqq.ts
function isOneBotPlatform(platform) {
	return platform === "onebot";
}
function createOneBotRuntime(deps) {
	const { callApi, serializeReply, wrapCompatValue, safeInt, resolveMasterFlag, buildForwardMsgCompat } = deps;
	const MAX_CACHED_GROUPS = 50;
	const memberCache = /* @__PURE__ */ new Map();
	const memberCacheAccess = /* @__PURE__ */ new Map();
	let botState = null;
	function touchMemberCache(groupId) {
		memberCacheAccess.set(groupId, Date.now());
		if (memberCache.size <= MAX_CACHED_GROUPS) return;
		let oldestId = -1;
		let oldestTime = Infinity;
		for (const [gid, time] of memberCacheAccess) if (time < oldestTime) {
			oldestTime = time;
			oldestId = gid;
		}
		if (oldestId >= 0) {
			memberCache.delete(oldestId);
			memberCacheAccess.delete(oldestId);
		}
	}
	function normalizeFriendRecord(friend) {
		const nickname = friend?.nickname ?? friend?.user_name ?? friend?.card ?? "";
		const remark = friend?.remark ?? friend?.card ?? nickname;
		return {
			...friend,
			nickname,
			card: friend?.card ?? remark,
			remark
		};
	}
	function normalizeGroupRecord(group) {
		return {
			...group,
			group_id: group?.group_id,
			group_name: group?.group_name ?? group?.group_name_display ?? group?.name ?? "",
			member_count: group?.member_count ?? 0,
			max_member_count: group?.max_member_count ?? 0
		};
	}
	function normalizeMemberRecord(member) {
		const nickname = member?.nickname ?? member?.card ?? "";
		const card = member?.card ?? nickname;
		const remark = member?.remark ?? card ?? nickname;
		const role = member?.role ?? "member";
		return {
			...member,
			user_id: member?.user_id,
			nickname,
			card,
			remark,
			role,
			title: member?.title ?? "",
			level: member?.level ?? 0
		};
	}
	function getCachedGroupRecord(groupId, opts) {
		const cached = botState?.gl?.get(groupId);
		return normalizeGroupRecord({
			group_id: groupId,
			group_name: opts?.name ?? cached?.group_name ?? `Group ${groupId}`,
			...cached
		});
	}
	function cacheGroupRecord(groupId, group, opts) {
		const definedGroup = Object.fromEntries(Object.entries(group ?? {}).filter(([, value]) => value !== void 0));
		const normalized = normalizeGroupRecord({
			...getCachedGroupRecord(groupId, opts),
			...definedGroup,
			group_id: groupId
		});
		botState?.gl?.set(groupId, normalized);
		return normalized;
	}
	function getCachedMemberRecord(groupId, userId) {
		return normalizeMemberRecord(memberCache.get(groupId)?.get(userId) ?? botState?.gml?.get(groupId)?.get(userId) ?? { user_id: userId });
	}
	function cacheMemberRecord(groupId, userId, member) {
		const normalized = normalizeMemberRecord({
			...getCachedMemberRecord(groupId, userId),
			...member,
			user_id: userId
		});
		let members = memberCache.get(groupId) ?? botState?.gml?.get(groupId);
		members ??= /* @__PURE__ */ new Map();
		members.set(userId, normalized);
		memberCache.set(groupId, members);
		botState?.gml?.set(groupId, members);
		touchMemberCache(groupId);
		return normalized;
	}
	function removeCachedMember(groupId, userId) {
		memberCache.get(groupId)?.delete(userId);
		botState?.gml?.get(groupId)?.delete(userId);
	}
	function fetchMemberRecord(groupId, userId, noCache = false) {
		const cached = getCachedMemberRecord(groupId, userId);
		return callApi("getGroupMemberInfo", {
			group_id: groupId,
			user_id: userId,
			...noCache ? { no_cache: true } : {}
		}).then((res) => cacheMemberRecord(groupId, userId, res?.data ?? cached)).catch(() => cached);
	}
	function extractText(message) {
		return message.filter((s) => s.type === "text").map((s) => s.data?.text ?? s.text ?? "").join("").trim();
	}
	function detectAtMe(message, selfId) {
		return message.some((s) => s.type === "at" && String(s.data?.qq ?? s.qq) === String(selfId));
	}
	function detectAtAll(message) {
		return message.some((s) => s.type === "at" && (s.data?.qq === "all" || s.qq === "all"));
	}
	function extractFirstAtTarget(message, selfId) {
		for (const s of message) {
			if (s.type !== "at") continue;
			const qq = s.data?.qq ?? s.qq;
			if (qq === null || qq === void 0 || qq === "all" || String(qq) === String(selfId)) continue;
			return qq;
		}
	}
	function parseCQMessage(str) {
		const segs = [];
		const re = /\[CQ:([^,\]]+)((?:,[^,\]]+)*)\]/g;
		let lastIdx = 0;
		let m;
		while ((m = re.exec(str)) !== null) {
			if (m.index > lastIdx) segs.push({
				type: "text",
				text: str.slice(lastIdx, m.index)
			});
			const type = m[1];
			const params = {};
			if (m[2]) for (const kv of m[2].slice(1).split(",")) {
				const eq = kv.indexOf("=");
				if (eq > 0) params[kv.slice(0, eq)] = kv.slice(eq + 1);
			}
			segs.push({
				type,
				...params
			});
			lastIdx = re.lastIndex;
		}
		if (lastIdx < str.length) segs.push({
			type: "text",
			text: str.slice(lastIdx)
		});
		return segs;
	}
	function normalizeSegments(message) {
		return message.map((seg) => {
			if (seg.data && typeof seg.data === "object") return {
				type: seg.type,
				...seg.data
			};
			return seg;
		});
	}
	function createOneBotGroupAdapter(groupId, opts) {
		return wrapCompatValue({
			group_id: groupId,
			get group_name() {
				return getCachedGroupRecord(groupId, opts).group_name;
			},
			get name() {
				return getCachedGroupRecord(groupId, opts).group_name;
			},
			get member_count() {
				return getCachedGroupRecord(groupId, opts).member_count;
			},
			get max_member_count() {
				return getCachedGroupRecord(groupId, opts).max_member_count;
			},
			is_owner: opts?.is_owner ?? false,
			is_admin: opts?.is_admin ?? false,
			mute_left: 0,
			sendMsg: async (msg) => {
				const contents = await serializeReply(msg);
				return callApi("sendGroupMsg", {
					group_id: groupId,
					contents
				});
			},
			getMemberMap: () => callApi("getGroupMemberList", { group_id: groupId }).then((res) => {
				const map = /* @__PURE__ */ new Map();
				if (res?.data && Array.isArray(res.data)) for (const member of res.data) {
					const normalized = normalizeMemberRecord(member);
					map.set(normalized.user_id, normalized);
				}
				memberCache.set(groupId, map);
				touchMemberCache(groupId);
				botState?.gml?.set(groupId, map);
				return map;
			}).catch(() => memberCache.get(groupId) ?? botState?.gml?.get(groupId) ?? /* @__PURE__ */ new Map()),
			pickMember: (uid) => {
				const current = () => getCachedMemberRecord(groupId, uid);
				const updateAfter = (action, params, patch = {}, remove = false) => callApi(action, params).then((result) => {
					if (remove) removeCachedMember(groupId, uid);
					else cacheMemberRecord(groupId, uid, {
						...current(),
						...patch
					});
					return result;
				}).catch(() => false);
				return wrapCompatValue({
					user_id: uid,
					group_id: groupId,
					get card() {
						return current().card;
					},
					get nickname() {
						return current().nickname;
					},
					get remark() {
						return current().remark;
					},
					get title() {
						return current().title;
					},
					get role() {
						return current().role;
					},
					get level() {
						return current().level;
					},
					get is_admin() {
						return current().role === "admin" || current().role === "owner";
					},
					get is_owner() {
						return current().role === "owner";
					},
					is_friend: false,
					get mute_left() {
						const timestamp = current().shut_up_timestamp;
						return timestamp ? Math.max(0, timestamp - Math.floor(Date.now() / 1e3)) : 0;
					},
					get _info() {
						return current();
					},
					group: createOneBotGroupAdapter(groupId, opts),
					get info() {
						return fetchMemberRecord(groupId, uid);
					},
					getInfo: (noCache = false) => fetchMemberRecord(groupId, uid, noCache),
					renew: () => fetchMemberRecord(groupId, uid, true),
					setAdmin: (yes = true) => updateAfter("setGroupAdmin", {
						group_id: groupId,
						user_id: uid,
						enable: yes
					}, { role: yes ? "admin" : "member" }),
					setTitle: (title = "", duration = -1) => updateAfter("setGroupSpecialTitle", {
						group_id: groupId,
						user_id: uid,
						special_title: title,
						duration
					}, { title }),
					setCard: (card = "") => updateAfter("setGroupCard", {
						group_id: groupId,
						user_id: uid,
						card
					}, {
						card,
						remark: card
					}),
					kick: (_msg = "", block = false) => updateAfter("setGroupKick", {
						group_id: groupId,
						user_id: uid,
						reject_add_request: block
					}, {}, true),
					mute: (duration = 600) => updateAfter("setGroupBan", {
						group_id: groupId,
						user_id: uid,
						duration
					}, { shut_up_timestamp: duration > 0 ? Math.floor(Date.now() / 1e3) + duration : 0 }),
					poke: () => callApi("pokeMember", {
						group_id: groupId,
						user_id: uid
					}).catch(() => false),
					addFriend: (comment = "") => callApi("_add_friend", {
						user_id: uid,
						comment
					}).catch(() => false),
					setScreenMsg: (isScreen = true) => callApi("_set_group_screen_msg", {
						group_id: groupId,
						user_id: uid,
						is_screen: isScreen
					}).catch(() => false),
					getAvatarUrl: () => `https://q1.qlogo.cn/g?b=qq&s=0&nk=${uid}`
				}, `Group(${groupId}).pickMember(${uid})`);
			},
			recallMsg: (messageId) => callApi("deleteMsg", { message_id: messageId }).catch(() => false),
			muteMember: (uid, duration = 600) => createOneBotGroupAdapter(groupId, opts).pickMember(uid).mute(duration),
			kickMember: (uid, rejectAdd = false) => createOneBotGroupAdapter(groupId, opts).pickMember(uid).kick("", rejectAdd),
			pokeMember: (uid) => callApi("pokeMember", {
				group_id: groupId,
				user_id: uid
			}).catch(() => false),
			setCard: (uid, card) => createOneBotGroupAdapter(groupId, opts).pickMember(uid).setCard(card),
			setAdmin: (uid, enable = true) => createOneBotGroupAdapter(groupId, opts).pickMember(uid).setAdmin(enable),
			setTitle: (uid, title, duration = -1) => createOneBotGroupAdapter(groupId, opts).pickMember(uid).setTitle(title, duration),
			quit: () => callApi("setGroupLeave", { group_id: groupId }).catch(() => false),
			setName: (name) => callApi("setGroupName", {
				group_id: groupId,
				group_name: name
			}).then((result) => {
				cacheGroupRecord(groupId, { group_name: name }, opts);
				return result;
			}).catch(() => false),
			muteAll: (enable = true) => callApi("setGroupWholeBan", {
				group_id: groupId,
				enable
			}).then((result) => {
				cacheGroupRecord(groupId, { all_muted: enable }, opts);
				return result;
			}).catch(() => false),
			makeForwardMsg: (nodes) => buildForwardMsgCompat(nodes),
			getInfo: () => callApi("getGroupInfo", { group_id: groupId }).then((res) => cacheGroupRecord(groupId, res?.data ?? {}, opts)).catch(() => getCachedGroupRecord(groupId, opts)),
			getChatHistory: (seq, count = 1) => callApi("getChatHistory", {
				group_id: groupId,
				message_seq: seq,
				count
			}).then((res) => res?.data?.messages ?? res?.messages ?? res ?? []).catch(() => []),
			getFileUrl: (fid) => callApi("getGroupFileUrl", {
				group_id: groupId,
				file_id: fid
			}).then((res) => res?.data?.url ?? res?.url ?? "").catch(() => ""),
			getAvatarUrl: (size = 0) => `https://p.qlogo.cn/gh/${groupId}/${groupId}/${size || 640}/`,
			renew: () => callApi("getGroupInfo", {
				group_id: groupId,
				no_cache: true
			}).then((res) => cacheGroupRecord(groupId, res?.data ?? {}, opts)).catch(() => getCachedGroupRecord(groupId, opts)),
			get all_muted() {
				return Boolean(getCachedGroupRecord(groupId, opts).all_muted);
			},
			markRead: (seq) => callApi("mark_group_msg_as_read", {
				group_id: groupId,
				message_seq: seq
			}).catch(() => {}),
			announce: (content) => callApi("_send_group_notice", {
				group_id: groupId,
				content
			}).catch(() => false),
			allowAnony: (yes = true) => callApi("set_group_anonymous", {
				group_id: groupId,
				enable: yes
			}).catch(() => false),
			setRemark: (remark = "") => callApi("_set_group_remark", {
				group_id: groupId,
				remark
			}).catch(() => {}),
			muteAnony: (flag, duration = 1800) => callApi("set_group_anonymous_ban", {
				group_id: groupId,
				anonymous_flag: flag,
				duration
			}).catch(() => {}),
			getAnonyInfo: () => callApi("_get_group_anonymous_info", { group_id: groupId }).catch(() => ({})),
			getAtAllRemainder: () => callApi("get_group_at_all_remain", { group_id: groupId }).then((res) => res?.data?.remain_at_all_count_for_group ?? 0).catch(() => 0),
			addEssence: (seq) => callApi("set_essence_msg", { message_id: seq }).catch(() => ""),
			removeEssence: (seq) => callApi("delete_essence_msg", { message_id: seq }).catch(() => ""),
			sendFile: (file, _pid, name) => callApi("upload_group_file", {
				group_id: groupId,
				file: String(file),
				name: name ?? "file"
			}).catch(() => ({})),
			invite: (uid) => callApi("_set_group_invite", {
				group_id: groupId,
				user_id: uid
			}).catch(() => false),
			sign: () => callApi("send_group_sign", { group_id: groupId }).catch(() => ({})),
			setAvatar: (file) => callApi("set_group_portrait", {
				group_id: groupId,
				file: String(file)
			}).catch(() => {}),
			setScreenMemberMsg: (memberId, isScreen = true) => callApi("_set_group_screen_msg", {
				group_id: groupId,
				user_id: memberId,
				is_screen: isScreen
			}).catch(() => false),
			getMuteMemberList: () => callApi("_get_group_mute_list", { group_id: groupId }).then((res) => res?.data ?? []).catch(() => []),
			fs: wrapCompatValue({
				df: () => callApi("get_group_file_system_info", { group_id: groupId }).then((res) => res?.data ?? {}).catch(() => ({})),
				stat: (fid) => callApi("_get_group_file_stat", {
					group_id: groupId,
					file_id: fid
				}).then((res) => res?.data ?? {}).catch(() => ({})),
				dir: (pid = "/", start = 0, limit = 100) => callApi("get_group_files_by_folder", {
					group_id: groupId,
					folder_id: pid,
					start,
					limit
				}).then((res) => [...res?.data?.files ?? [], ...res?.data?.folders ?? []]).catch(() => []),
				ls: (pid = "/", start = 0, limit = 100) => callApi("get_group_files_by_folder", {
					group_id: groupId,
					folder_id: pid,
					start,
					limit
				}).then((res) => [...res?.data?.files ?? [], ...res?.data?.folders ?? []]).catch(() => []),
				mkdir: (name) => callApi("create_group_file_folder", {
					group_id: groupId,
					name,
					parent_id: "/"
				}).then((res) => res?.data ?? {}).catch(() => ({})),
				rm: (fid) => callApi("delete_group_file", {
					group_id: groupId,
					file_id: fid
				}).catch(() => {}),
				rename: (fid, name) => callApi("_rename_group_file", {
					group_id: groupId,
					file_id: fid,
					name
				}).catch(() => {}),
				mv: (fid, pid) => callApi("_move_group_file", {
					group_id: groupId,
					file_id: fid,
					parent_id: pid
				}).catch(() => {}),
				upload: (file, pid = "/", name) => callApi("upload_group_file", {
					group_id: groupId,
					file: String(file),
					name: name ?? "file",
					folder: pid
				}).then((res) => res?.data ?? {}).catch(() => ({})),
				download: (fid) => callApi("get_group_file_url", {
					group_id: groupId,
					file_id: fid
				}).then((res) => res?.data ?? {}).catch(() => ({})),
				get root_files() {
					return callApi("get_group_root_files", { group_id: groupId }).then((res) => [...res?.data?.files ?? [], ...res?.data?.folders ?? []]).catch(() => []);
				}
			}, `Group(${groupId}).fs`)
		}, `Group(${groupId})`);
	}
	function createOneBotFriendAdapter(userId, userName) {
		const currentFriend = () => normalizeFriendRecord(botState?.fl?.get(userId) ?? {});
		return wrapCompatValue({
			user_id: userId,
			get nickname() {
				return currentFriend().nickname ?? userName;
			},
			get remark() {
				return currentFriend().remark ?? userName;
			},
			get info() {
				return currentFriend();
			},
			get sex() {
				return currentFriend().sex ?? "unknown";
			},
			get class_id() {
				return currentFriend().class_id ?? 0;
			},
			get class_name() {
				return currentFriend().class_name ?? "";
			},
			asFriend: () => createOneBotFriendAdapter(userId, userName),
			asMember: (gid) => createOneBotGroupAdapter(gid).pickMember(userId),
			sendMsg: async (msg) => {
				const contents = await serializeReply(msg);
				return callApi("sendPrivateMsg", {
					user_id: userId,
					contents
				});
			},
			recallMsg: (messageId) => callApi("deleteMsg", { message_id: messageId }).catch(() => false),
			getAvatarUrl: (size = 0) => `https://q1.qlogo.cn/g?b=qq&s=${size || 640}&nk=${userId}`,
			thumbUp: (times = 10) => callApi("sendLike", {
				user_id: userId,
				times
			}).catch(() => false),
			poke: (self = false) => callApi("pokeFriend", { user_id: self ? 0 : userId }).catch(() => false),
			getChatHistory: (time, cnt = 20) => callApi("getChatHistory", {
				user_id: userId,
				message_seq: time,
				count: cnt
			}).then((res) => res?.data?.messages ?? res?.messages ?? res ?? []).catch(() => []),
			markRead: (time) => callApi("mark_private_msg_as_read", {
				user_id: userId,
				time
			}).catch(() => {}),
			getFileUrl: (fid) => callApi("getPrivateFileUrl", {
				user_id: userId,
				file_id: fid
			}).then((res) => res?.data?.url ?? res?.url ?? "").catch(() => ""),
			getFileInfo: (fid) => callApi("_get_private_file_info", {
				user_id: userId,
				file_id: fid
			}).then((res) => res?.data ?? {}).catch(() => ({})),
			sendFile: (file, filename) => callApi("upload_private_file", {
				user_id: userId,
				file: String(file),
				name: filename ?? "file"
			}).then((res) => res?.data?.file_id ?? "").catch(() => ""),
			recallFile: (fid) => callApi("_recall_private_file", {
				user_id: userId,
				file_id: fid
			}).catch(() => false),
			forwardFile: (fid, groupId) => callApi("_forward_file", {
				user_id: userId,
				file_id: fid,
				group_id: groupId
			}).then((res) => res?.data?.file_id ?? "").catch(() => ""),
			delete: (block = false) => callApi("delete_friend", {
				user_id: userId,
				block
			}).catch(() => false),
			setRemark: (remark) => callApi("_set_friend_remark", {
				user_id: userId,
				remark
			}).catch(() => {}),
			setClass: (id) => callApi("_set_friend_class", {
				user_id: userId,
				class_id: id
			}).catch(() => {}),
			addFriendBack: (seq, remark = "") => callApi("setFriendAddRequest", {
				flag: String(seq),
				approve: true,
				remark
			}).catch(() => false),
			setFriendReq: (seq, yes = true, remark = "") => callApi("setFriendAddRequest", {
				flag: String(seq),
				approve: yes,
				remark
			}).catch(() => false),
			setGroupReq: (_gid, seq, yes = true, reason = "") => callApi("setGroupAddRequest", {
				flag: String(seq),
				approve: yes,
				reason,
				type: "add"
			}).catch(() => false),
			setGroupInvite: (_gid, seq, yes = true) => callApi("setGroupAddRequest", {
				flag: String(seq),
				approve: yes,
				type: "invite"
			}).catch(() => false),
			getSimpleInfo: () => callApi("getStrangerInfo", { user_id: userId }).then((res) => res?.data ?? {}).catch(() => ({})),
			getAddFriendSetting: () => callApi("_get_add_friend_setting", { user_id: userId }).then((res) => res?.data ?? 0).catch(() => 0),
			searchSameGroup: () => callApi("_search_same_group", { user_id: userId }).then((res) => res?.data ?? []).catch(() => []),
			makeForwardMsg: (nodes) => buildForwardMsgCompat(nodes)
		}, `Friend(${userId})`);
	}
	function createOneBotBotAdapter(state) {
		botState = state;
		return {
			getFriendMap: () => state.fl,
			getGroupMap: () => state.gl,
			pickFriend: (uid) => createOneBotFriendAdapter(uid, ""),
			pickGroup: (gid) => createOneBotGroupAdapter(gid),
			pickUser: (uid) => createOneBotFriendAdapter(uid, ""),
			pickMember: (gid, uid) => createOneBotGroupAdapter(gid).pickMember(uid),
			sendGroupMsg: async (gid, msg) => {
				const contents = await serializeReply(msg);
				return callApi("sendGroupMsg", {
					group_id: gid,
					contents
				});
			},
			sendPrivateMsg: async (uid, msg) => {
				const contents = await serializeReply(msg);
				return callApi("sendPrivateMsg", {
					user_id: uid,
					contents
				});
			},
			getGroupList: () => callApi("getGroupList").then((res) => {
				if (res?.data && Array.isArray(res.data)) {
					state.gl.clear();
					for (const group of res.data) {
						const normalized = normalizeGroupRecord(group);
						state.gl.set(normalized.group_id, normalized);
					}
				}
				return state.gl;
			}).catch(() => state.gl),
			getFriendList: () => callApi("getFriendList").then((res) => {
				if (res?.data && Array.isArray(res.data)) {
					state.fl.clear();
					for (const friend of res.data) {
						const normalized = normalizeFriendRecord(friend);
						state.fl.set(normalized.user_id, normalized);
					}
				}
				return state.fl;
			}).catch(() => state.fl),
			getStrangerInfo: (uid) => callApi("getStrangerInfo", { user_id: uid }).catch(() => ({})),
			getLoginInfo: () => callApi("getLoginInfo").then((res) => {
				if (res?.data) {
					state.uin = res.data.UserId ?? res.data.user_id ?? state.uin;
					state.nickname = res.data.UserName ?? res.data.nickname ?? state.nickname;
					state.avatar = res.data.avatar ?? state.avatar;
				}
				return {
					user_id: state.uin,
					nickname: state.nickname
				};
			}).catch(() => ({
				user_id: state.uin,
				nickname: state.nickname
			})),
			getGroupMemberList: (gid) => callApi("getGroupMemberList", { group_id: gid }).then((res) => {
				if (res?.data && Array.isArray(res.data)) {
					const map = /* @__PURE__ */ new Map();
					for (const member of res.data) {
						const normalized = normalizeMemberRecord(member);
						map.set(normalized.user_id, normalized);
					}
					state.gml.set(gid, map);
					memberCache.set(gid, map);
					touchMemberCache(gid);
					return map;
				}
				return state.gml.get(gid) ?? memberCache.get(gid) ?? /* @__PURE__ */ new Map();
			}).catch(() => state.gml.get(gid) ?? memberCache.get(gid) ?? /* @__PURE__ */ new Map()),
			getGroupMemberInfo: (gid, uid) => callApi("getGroupMemberInfo", {
				group_id: gid,
				user_id: uid
			}).then((res) => normalizeMemberRecord(res?.data ?? {})).catch(() => ({})),
			getForwardMsg: (resId) => callApi("getForwardMsg", { id: resId }).catch(() => ({ message: [] })),
			getCookies: (domain) => callApi("getCookies", { domain: domain ?? "" }).catch(() => ({ cookies: "" })),
			getCsrfToken: () => callApi("getCsrfToken").catch(() => ({ token: 0 })),
			sendLike: (uid, times = 10) => callApi("sendLike", {
				user_id: uid,
				times
			}).catch(() => false),
			getStrangerList: () => callApi("get_stranger_list").catch(() => []),
			reloadFriendList: () => state.getFriendList(),
			reloadGroupList: () => state.getGroupList(),
			reloadBlackList: () => callApi("get_blacklist").catch(() => []),
			setOnlineStatus: (status) => callApi("set_online_status", { status }).catch(() => false),
			setNickname: (nickname) => callApi("set_qq_profile", { nickname }).catch(() => false),
			setGender: (gender) => callApi("set_qq_profile", { gender }).catch(() => false),
			setBirthday: (birthday) => callApi("set_qq_profile", { birthday }).catch(() => false),
			setDescription: (description) => callApi("set_qq_profile", { description }).catch(() => false),
			setSignature: (signature) => callApi("set_qq_profile", { signature }).catch(() => false),
			setAvatar: (file) => callApi("set_qq_avatar", { file: String(file) }).catch(() => false),
			getSignature: () => callApi("get_qq_profile").then((r) => r?.data?.signature ?? "").catch(() => ""),
			imageOcr: (image) => callApi("ocr_image", { image }).catch(() => ({
				texts: [],
				language: ""
			})),
			getVideoUrl: (fid, md5) => callApi(".get_video_url", {
				fid,
				md5
			}).catch(() => ""),
			getSystemMsg: () => callApi("get_group_system_msg").catch(() => ({
				InvitedRequests: [],
				join_requests: []
			})),
			setEssenceMessage: (messageId) => callApi("set_essence_msg", { message_id: messageId }).catch(() => false),
			removeEssenceMessage: (messageId) => callApi("delete_essence_msg", { message_id: messageId }).catch(() => false),
			getRoamingStamp: () => callApi(".get_roaming_stamp").catch(() => []),
			deleteStamp: (id) => callApi(".delete_stamp", { id }).catch(() => false),
			cleanCache: () => callApi("clean_cache").catch(() => false),
			addClass: (name) => callApi(".add_class", { name }).catch(() => false),
			deleteClass: (id) => callApi(".delete_class", { id }).catch(() => false),
			renameClass: (id, name) => callApi(".rename_class", {
				id,
				name
			}).catch(() => false),
			makeForwardMsg: (msgs) => buildForwardMsgCompat(msgs)
		};
	}
	function buildOneBotEvent({ data, msgId, selfId, reply }) {
		const raw = data.rawEvent;
		if (!raw || typeof raw !== "object" || !raw.post_type) return null;
		const masterFlag = resolveMasterFlag(data);
		const userId = raw.user_id ?? safeInt(data.userId, 10001);
		const groupId = raw.group_id ?? safeInt(data.spaceId, 0);
		if (raw.post_type !== "message") {
			const e = {
				...raw,
				self_id: raw.self_id ?? selfId,
				time: raw.time ?? Math.floor(Date.now() / 1e3),
				user_id: userId,
				group_id: groupId,
				isMaster: masterFlag,
				isOwner: masterFlag,
				isAdmin: masterFlag,
				reply,
				getMemberMap: () => groupId ? createOneBotGroupAdapter(groupId).getMemberMap() : /* @__PURE__ */ new Map(),
				getAvatarUrl: (size = 0) => data.userAvatar ?? `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`,
				logText: `[${raw.post_type}:${raw.notice_type ?? raw.request_type ?? "unknown"}:${groupId ?? userId}]`,
				logFnc: ""
			};
			if (groupId) {
				cacheGroupRecord(groupId, { group_name: raw.group_name });
				cacheMemberRecord(groupId, userId, {
					...raw.member,
					...raw.sender,
					user_id: userId,
					nickname: raw.sender?.nickname ?? raw.member?.nickname ?? data.userName ?? "",
					card: raw.sender?.card ?? raw.member?.card ?? data.userName ?? ""
				});
				e.group = createOneBotGroupAdapter(groupId);
			}
			if (userId) {
				e.friend = createOneBotFriendAdapter(userId, data.userName ?? "User");
				e.member = groupId ? createOneBotGroupAdapter(groupId).pickMember(userId) : {
					user_id: userId,
					card: raw.sender?.card ?? raw.member?.card ?? data.userName ?? "",
					nickname: raw.sender?.nickname ?? raw.member?.nickname ?? data.userName ?? "",
					role: raw.sender?.role ?? "member",
					is_admin: raw.sender?.role === "admin" || raw.sender?.role === "owner",
					is_owner: raw.sender?.role === "owner",
					_info: {
						card: raw.sender?.card ?? raw.member?.card ?? data.userName ?? "",
						nickname: raw.sender?.nickname ?? raw.member?.nickname ?? data.userName ?? ""
					},
					getAvatarUrl: (size = 0) => data.userAvatar ?? `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`
				};
			}
			e.sender = {
				user_id: userId,
				nickname: raw.sender?.nickname ?? data.userName ?? "User",
				card: raw.sender?.card ?? raw.sender?.nickname ?? data.userName ?? "",
				role: raw.sender?.role ?? "member"
			};
			e.nickname = raw.sender?.nickname ?? data.userName ?? "User";
			if (raw.post_type === "request") {
				e.approve = (approve = true) => callApi(raw.request_type === "friend" ? "setFriendAddRequest" : "setGroupAddRequest", {
					flag: raw.flag,
					approve,
					type: raw.sub_type
				}).catch(() => false);
				e.reject = (reason = "") => callApi(raw.request_type === "friend" ? "setFriendAddRequest" : "setGroupAddRequest", {
					flag: raw.flag,
					approve: false,
					reason,
					type: raw.sub_type
				}).catch(() => false);
			}
			return e;
		}
		const isGroup = raw.message_type === "group";
		const normalizedMessage = normalizeSegments(Array.isArray(raw.message) ? raw.message : typeof raw.message === "string" ? parseCQMessage(raw.message) : [{
			type: "text",
			text: data.messageText
		}]);
		const rawMessage = raw.raw_message ?? extractText(normalizedMessage);
		const replySegment = normalizedMessage.find((s) => s.type === "reply");
		const source = raw.source ?? (replySegment ? {
			user_id: replySegment.qq ?? replySegment.user_id ?? 0,
			seq: replySegment.id ?? replySegment.seq ?? raw.message_id,
			time: raw.time ?? Math.floor(Date.now() / 1e3),
			message: replySegment.message ?? ""
		} : void 0);
		if (isGroup && groupId) {
			cacheGroupRecord(groupId, { group_name: raw.group_name });
			cacheMemberRecord(groupId, userId, {
				...raw.sender,
				user_id: userId,
				nickname: raw.sender?.nickname ?? data.userName ?? "",
				card: raw.sender?.card ?? raw.sender?.nickname ?? data.userName ?? ""
			});
		}
		const e = {
			post_type: raw.post_type ?? "message",
			message_type: raw.message_type ?? (isGroup ? "group" : "private"),
			sub_type: raw.sub_type ?? (isGroup ? "normal" : "friend"),
			message_id: raw.message_id ?? msgId,
			user_id: userId,
			group_id: groupId,
			group_name: raw.group_name ?? (isGroup ? `Group ${groupId}` : ""),
			self_id: raw.self_id ?? selfId,
			time: raw.time ?? Math.floor(Date.now() / 1e3),
			seq: raw.message_seq ?? raw.seq ?? Date.now(),
			rand: raw.rand ?? Math.random(),
			font: raw.font ?? "",
			message: normalizedMessage,
			raw_message: rawMessage,
			msg: "",
			sender: {
				user_id: userId,
				nickname: raw.sender?.nickname ?? data.userName ?? "User",
				card: raw.sender?.card ?? raw.sender?.nickname ?? data.userName ?? "",
				role: raw.sender?.role ?? "member",
				level: raw.sender?.level,
				title: raw.sender?.title ?? "",
				sex: raw.sender?.sex,
				age: raw.sender?.age,
				area: raw.sender?.area
			},
			atme: detectAtMe(normalizedMessage, selfId),
			atall: detectAtAll(normalizedMessage),
			at: extractFirstAtTarget(normalizedMessage, selfId) ?? void 0,
			source,
			hasReply: !!replySegment,
			isMaster: masterFlag,
			isOwner: masterFlag,
			isAdmin: masterFlag || raw.sender?.role === "admin" || raw.sender?.role === "owner",
			reply,
			getMemberMap: () => isGroup ? createOneBotGroupAdapter(groupId).getMemberMap() : /* @__PURE__ */ new Map(),
			getAvatarUrl: (size = 0) => data.userAvatar || `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`,
			toString: () => rawMessage,
			...isGroup ? {
				group: createOneBotGroupAdapter(groupId, {
					name: raw.group_name ?? `Group ${groupId}`,
					is_owner: raw.sender?.role === "owner",
					is_admin: raw.sender?.role === "admin" || raw.sender?.role === "owner"
				}),
				friend: void 0
			} : {
				group: void 0,
				friend: createOneBotFriendAdapter(userId, raw.sender?.nickname ?? data.userName ?? "User")
			},
			member: isGroup && groupId ? createOneBotGroupAdapter(groupId).pickMember(userId) : {
				user_id: userId,
				card: raw.sender?.card ?? raw.sender?.nickname ?? data.userName ?? "",
				nickname: raw.sender?.nickname ?? data.userName ?? "",
				role: raw.sender?.role ?? "member",
				is_admin: raw.sender?.role === "admin" || raw.sender?.role === "owner",
				is_owner: raw.sender?.role === "owner",
				_info: {
					card: raw.sender?.card ?? raw.sender?.nickname ?? data.userName ?? "",
					nickname: raw.sender?.nickname ?? data.userName ?? "",
					role: raw.sender?.role ?? "member"
				},
				getAvatarUrl: (size = 0) => data.userAvatar || `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}`
			},
			nickname: raw.sender?.card ?? raw.sender?.nickname ?? data.userName ?? "User",
			makeForwardMsg: (nodes) => {
				if (isGroup && groupId) return createOneBotGroupAdapter(groupId).makeForwardMsg(nodes);
				return createOneBotFriendAdapter(userId, data.userName ?? "User").makeForwardMsg(nodes);
			}
		};
		e.original_msg = rawMessage;
		e.logText = `[${isGroup ? "Group" : "Private"}:${isGroup ? groupId : userId}] ${rawMessage}`;
		e.logFnc = "";
		return e;
	}
	return {
		createOneBotBotAdapter,
		createOneBotGroupAdapter,
		createOneBotFriendAdapter,
		buildOneBotEvent,
		normalizeFriendRecord,
		normalizeGroupRecord,
		normalizeMemberRecord
	};
}

//#endregion
export { createOneBotRuntime, isOneBotPlatform };