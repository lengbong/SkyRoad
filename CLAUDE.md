# 작업 규칙

## 합치기: PR 없이 master에 바로

저장소 주인이 허락했어요: 작업이 끝나면 **PR을 만들지 말고 `master`에 바로 합쳐요.**
(`master`에 푸시하면 GitHub Actions가 테스트·빌드를 거쳐 GitHub Pages에 배포해요.)

1. 작업 브랜치에서 커밋해요.
2. `git fetch origin master && git rebase origin/master` 로 최신 `master` 위에 올려요.
3. 합치기 전에 모두 통과하는지 확인해요:
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
4. `git push origin HEAD:master` 로 푸시해요. (작업 브랜치도 함께 푸시해 둬요.)
5. GitHub Actions의 ‘빌드 및 배포’ 실행이 성공했는지(Pages 배포까지) 확인하고 알려 줘요.
   실패하면 원인을 찾아 고치고 다시 합쳐요.

PR은 저장소 주인이 따로 부탁할 때만 만들어요.

## 저장 이름은 바꾸지 않아요

이 게임은 원래 [우리 가족 보드게임](https://github.com/lengbong/BoardGame) 안에 있다가 옮겨 왔어요.
두 사이트 모두 `lengbong.github.io`에 있어서 브라우저 저장소를 함께 써요. 그래서 예전에 하던 게임이 새 주소에서도 이어져요.
아래 이름을 바꾸면 하던 게임·업적·명예의 전당이 사라진 것처럼 보이니 **그대로 둬요.**

- localStorage 열쇠: `family-boardgame.airline.*`, `family-boardgame.guides-seen.v1`
- IndexedDB 이름: `family-boardgame` (`src/games/airline/saveDb.ts`)

## 워크플로 파일은 Claude가 직접 올릴 수 없어요

Claude GitHub 앱에는 `.github/workflows/` 파일을 만들거나 고칠 권한이 없어요(푸시가 거절돼요).
워크플로를 바꿔야 하면 `ci/build.yml`에 새 내용을 두고 푸시한 뒤, 저장소 주인에게 GitHub 웹에서
`.github/workflows/build.yml`로 옮겨(또는 내용을 붙여 넣어) 달라고 부탁해요.
