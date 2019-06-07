import * as React from "react";
import PropTypes from "prop-types";
import { Grid, Typography } from "@material-ui/core";
import { Warning } from "@material-ui/icons";
import { withStyles } from "@material-ui/core/styles";

const styles = () => ({
  warningIcon: {
    fontSize: 20,
    verticalAlign: "bottom"
  }
});

const VideoQuality = ({
  classes,
  framerate: fps,
  speed,
  droppedVideoFrames: dropped,
  totalVideoFrames: total
}) => {
  if ([fps, speed, dropped / total].some(n => !Number.isFinite(n))) return null;
  const isLowQuality = dropped / total > 1e-3;

  return (
    <Grid container>
      <Grid item xs component="dl">
        <Typography component="dt">フレームレート</Typography>
        <Typography component="dd">
          {fps < 0 ? "-" : `${fps} fps${speed === 1 ? "" : ` × ${speed}`}`}
        </Typography>
      </Grid>
      <Grid item xs>
        <Typography component="dt">フレームドロップ率</Typography>
        <Typography
          component="dd"
          gutterBottom={isLowQuality}
          color={isLowQuality ? "error" : "textPrimary"}
        >
          {`${((dropped / total) * 100).toFixed(2)} % (${dropped} / ${total})`}
        </Typography>
      </Grid>
      {isLowQuality ? (
        <Grid item xs={12}>
          <Typography variant="caption" component="small" color="error">
            <Warning className={classes.warningIcon} />
            フレームドロップが発生したため実際の体感品質とは異なる可能性があります。
          </Typography>
        </Grid>
      ) : null}
    </Grid>
  );
};

VideoQuality.propTypes = {
  classes: PropTypes.instanceOf(Object).isRequired,
  framerate: PropTypes.number,
  speed: PropTypes.number,
  droppedVideoFrames: PropTypes.number,
  totalVideoFrames: PropTypes.number
};
VideoQuality.defaultProps = {
  framerate: undefined,
  speed: undefined,
  droppedVideoFrames: undefined,
  totalVideoFrames: undefined
};

export default withStyles(styles)(VideoQuality);
