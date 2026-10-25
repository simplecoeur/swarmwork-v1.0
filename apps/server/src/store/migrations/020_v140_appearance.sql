-- 020_v140_appearance.sql —— v1.4.0 I 小人形象定制：成员外观 JSON。
-- members.appearance 存 JSON（{skin,shirt,hairColor,hairStyle}，字段皆可缺省）；空串 = 未定制，
-- 画布沿用 v1.3.0 自动推导（衬衫/发色按工种、肤色按 id 哈希），渲染像素级不变。
ALTER TABLE members ADD COLUMN appearance TEXT NOT NULL DEFAULT '';
