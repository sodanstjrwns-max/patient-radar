-- 리뷰 질 지표 (2026-09-25): 글자수·사진
ALTER TABLE reviews ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_stats ADD COLUMN avg_len REAL;          -- 평균 글자수(공백 제외)
ALTER TABLE review_stats ADD COLUMN long_count INTEGER NOT NULL DEFAULT 0;  -- 100자 이상
ALTER TABLE review_stats ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0; -- 사진 있는 리뷰 수
